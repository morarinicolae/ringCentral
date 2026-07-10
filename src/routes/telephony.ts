import { Router } from 'express';
import { prisma } from '../db';
import { logger } from '../logger';
import { getOrAssignSellerForCall } from '../services/calls';
import { forwardCall } from '../services/call-control';
import { rcConfigForLine } from '../services/ringcentral';
import { sendTelegramMessage } from '../services/telegram';
import { getSellerLineTopic } from '../services/routing';

export const telephonyRouter = Router();

// Dedupe: forward a session at most once (Setup -> Proceeding -> Answered fire
// many events for the same call). Value = timestamp for cheap expiry.
const handledSessions = new Map<string, number>();

/**
 * RingCentral Telephony Session webhook.
 *
 * 1. Subscription handshake: the first request carries a `Validation-Token`
 *    header that MUST be echoed back in the response header.
 * 2. Inbound call: on the first ringing party (status Setup/Proceeding), resolve
 *    the sticky seller and FORWARD the still-ringing call to their mobile.
 */
telephonyRouter.post('/', async (req, res) => {
  // (1) Endpoint-verification handshake.
  const validation = req.header('Validation-Token');
  if (validation) {
    res.set('Validation-Token', validation);
    res.status(200).end();
    return;
  }

  // Ack immediately — RingCentral expects a fast 200, then we work async.
  res.status(200).end();

  try {
    const body = (req.body?.body ?? {}) as any;
    const sessionId: string | undefined = body.telephonySessionId;
    const parties: any[] = body.parties ?? [];
    if (!sessionId || parties.length === 0) return;

    // The still-ringing inbound leg is the one we can forward.
    const party = parties.find(
      (p) => p?.direction === 'Inbound' && (p?.status?.code === 'Setup' || p?.status?.code === 'Proceeding'),
    );
    if (!party) return;

    if (handledSessions.has(sessionId)) return;
    handledSessions.set(sessionId, Date.now());
    if (handledSessions.size > 500) {
      const cutoff = Date.now() - 3_600_000;
      for (const [k, ts] of handledSessions) if (ts < cutoff) handledSessions.delete(k);
    }

    const from: string | undefined = party.from?.phoneNumber;
    const to: string | undefined = party.to?.phoneNumber;
    if (!from || !to) return;

    // Sticky owner (existing caller -> same seller; new -> round-robin + stuck).
    const owner = await getOrAssignSellerForCall(from, to);
    if (!owner) {
      logger.warn('live_call_unrouted', { from, to });
      return;
    }
    logger.info('live_call_routed', { from, to, sellerId: owner.seller.id, sellerName: owner.seller.name, isNew: owner.isNewContact });

    // Forward the ringing call to the seller's mobile (latency-critical first).
    if (owner.seller.phoneE164) {
      const line = await prisma.line.findUnique({ where: { id: owner.line.id } });
      const rc = rcConfigForLine(line);
      await forwardCall(rc, sessionId, party.id, owner.seller.phoneE164);
    } else {
      logger.warn('live_call_no_forward_number', { sellerId: owner.seller.id, sellerName: owner.seller.name });
    }

    // Notify the seller's Telegram (group/topic) that a call is coming in.
    if (owner.seller.telegramUserId) {
      const topicId = await getSellerLineTopic(owner.seller.id, owner.line.id);
      const note = owner.seller.phoneE164
        ? `📞 Apel de la ${from} — ți-l transfer acum pe ${owner.seller.phoneE164}.`
        : `📞 Apel de la ${from} pe linia ${owner.line.name} — clientul e al tău (nu ai număr de transfer setat).`;
      await sendTelegramMessage(owner.seller.telegramUserId, note, { messageThreadId: topicId ?? undefined });
    }
  } catch (e) {
    logger.error('telephony_webhook_error', { error: e instanceof Error ? e.message : String(e) });
  }
});
