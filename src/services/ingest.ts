import { createHash } from 'crypto';
import { prisma } from '../db';
import { logger, Decision } from '../logger';
import { InboundSms, WebhookProvider } from '../types';
import { processInboundSms, InboundResult } from './inbound';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic event hash (rule 1). Prefer the RingCentral message id(s);
 * otherwise derive from from/to/timestamp/body so a re-delivered event with no
 * id still dedupes. Derived from the LOGICAL messages, not the HTTP envelope,
 * so envelope noise (uuids, headers) can't defeat dedupe.
 */
export function computeEventHash(provider: WebhookProvider, inbounds: InboundSms[]): string {
  const withIds = inbounds.filter((m) => m.ringcentralMessageId);
  if (withIds.length === inbounds.length && inbounds.length > 0) {
    return `${provider}:id:${withIds.map((m) => m.ringcentralMessageId).sort().join(',')}`;
  }
  const basis = inbounds
    .map((m) => `${m.from}|${m.to}|${m.text}|${m.timestamp ?? ''}`)
    .sort()
    .join('||');
  return `${provider}:hash:${sha256(basis)}`;
}

/**
 * Parse a RingCentral webhook payload into normalized inbound SMS records.
 * Handles several shapes so the same code path works for real webhooks and the
 * simulate endpoint:
 *   - normalized: { from, to, text, ringcentral_message_id?, timestamp? }
 *   - RC instant SMS event: { body: { from:{phoneNumber}, to:[{phoneNumber}], subject, id, creationTime, direction } }
 *   - { message: {...} } / { messages: [...] }
 *
 * NOTE: RingCentral message-store *change* events (body.changes) only carry
 * new message ids, not their text — those require a follow-up fetch. That is
 * intentionally left as a TODO for the reconciliation job; see
 * src/routes/admin.ts (reconcile-recent-sms).
 */
export function extractInboundFromRingCentral(payload: any): InboundSms[] {
  const out: InboundSms[] = [];

  const pushFrom = (m: any) => {
    if (!m) return;
    // Normalized shape (simulate + our own):
    const directFrom = m.from?.phoneNumber ?? m.from;
    const directTo = Array.isArray(m.to) ? m.to[0]?.phoneNumber : m.to?.phoneNumber ?? m.to;
    const text = m.text ?? m.subject ?? m.body;
    const id = m.ringcentral_message_id ?? m.ringcentralMessageId ?? (typeof m.id !== 'object' ? m.id : undefined);
    const timestamp = m.timestamp ?? m.creationTime ?? undefined;
    if (typeof directFrom === 'string' && typeof text === 'string') {
      // Only ingest inbound-direction messages when direction is provided.
      if (m.direction && String(m.direction).toLowerCase() !== 'inbound') return;
      out.push({
        from: directFrom,
        to: typeof directTo === 'string' ? directTo : '',
        text,
        ringcentralMessageId: id != null ? String(id) : undefined,
        timestamp: timestamp != null ? String(timestamp) : undefined,
      });
    }
  };

  if (Array.isArray(payload?.messages)) payload.messages.forEach(pushFrom);
  else if (payload?.message) pushFrom(payload.message);
  else if (payload?.body?.messages && Array.isArray(payload.body.messages)) payload.body.messages.forEach(pushFrom);
  else if (payload?.body && (payload.body.from || payload.body.text || payload.body.subject)) pushFrom(payload.body);
  else pushFrom(payload);

  return out;
}

export interface IngestSummary {
  webhookEventId: string;
  status: 'processed' | 'duplicate' | 'failed';
  results: InboundResult[];
  error?: string;
}

/**
 * Store the raw event FIRST (rule: never lose the raw event), dedupe at the
 * webhook layer, then process. Marks the webhook_event processed/duplicate/failed.
 */
export async function ingestInbounds(
  provider: WebhookProvider,
  inbounds: InboundSms[],
  rawPayload: unknown,
): Promise<IngestSummary> {
  const eventHash = computeEventHash(provider, inbounds);
  const externalEventId = inbounds.find((m) => m.ringcentralMessageId)?.ringcentralMessageId ?? null;

  // Fast path: if we've already seen this hash, it's a duplicate delivery.
  const prior = await prisma.webhookEvent.findUnique({ where: { eventHash } });
  if (prior) {
    logger.info(Decision.DUPLICATE_WEBHOOK, { provider, eventHash, priorId: prior.id });
    return { webhookEventId: prior.id, status: 'duplicate', results: [] };
  }

  // Store raw first. The try/catch remains as a race-safety net (two identical
  // deliveries arriving concurrently) — the unique index on event_hash wins.
  let event;
  try {
    event = await prisma.webhookEvent.create({
      data: {
        provider,
        externalEventId,
        eventHash,
        status: 'received',
        rawPayloadJson: JSON.stringify(rawPayload),
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Unique violation on event_hash -> duplicate webhook.
      const prior = await prisma.webhookEvent.findUnique({ where: { eventHash } });
      logger.info(Decision.DUPLICATE_WEBHOOK, { provider, eventHash, priorId: prior?.id });
      return { webhookEventId: prior?.id ?? 'unknown', status: 'duplicate', results: [] };
    }
    throw err;
  }

  if (inbounds.length === 0) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'failed', errorMessage: 'No inbound SMS could be extracted from payload', processedAt: new Date() },
    });
    return { webhookEventId: event.id, status: 'failed', results: [], error: 'no_inbound_extracted' };
  }

  try {
    const results: InboundResult[] = [];
    for (const inbound of inbounds) {
      results.push(await processInboundSms(inbound));
    }
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'processed', processedAt: new Date() },
    });
    return { webhookEventId: event.id, status: 'processed', results };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('webhook_processing_failed', { webhookEventId: event.id, error: message });
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'failed', errorMessage: message, processedAt: new Date() },
    });
    return { webhookEventId: event.id, status: 'failed', results: [], error: message };
  }
}
