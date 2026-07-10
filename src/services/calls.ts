import { prisma } from '../db';
import { config } from '../config';
import { logger, Decision } from '../logger';
import { normalizeE164, isValidE164 } from './phone';
import { assignNextSeller, getSellerLineTopic } from './routing';
import { resolveLineByNumber } from './lines';
import { writeAudit } from './audit';
import { sendTelegramMessage, formatCallNotification } from './telegram';

export interface InboundCall {
  from: string;
  to: string;
  ringcentralCallId?: string;
  /** Raw RingCentral result string (Accepted / Missed / Voicemail / ...). */
  result?: string;
  durationSec?: number;
  startedAt?: string;
}

export interface CallResult {
  status: 'processed' | 'duplicate' | 'rejected';
  reason?: string;
  callId?: string;
  lineId?: string;
  sellerId?: string;
  sellerName?: string;
  result?: string;
  isNewContact?: boolean;
  notified?: boolean;
}

/** Map RingCentral's call-log `result` to our normalized values. */
export function normalizeCallResult(raw?: string): string {
  const r = (raw ?? '').toLowerCase();
  if (r.includes('accept') || r.includes('connected') || r === 'call connected') return 'answered';
  if (r.includes('miss')) return 'missed';
  if (r.includes('voicemail') || r.includes('voice mail')) return 'voicemail';
  if (r.includes('reject')) return 'rejected';
  if (r.includes('busy')) return 'busy';
  return 'unknown';
}

/**
 * Resolve the STICKY owner of a live inbound call WITHOUT recording it (the
 * call-log poller records the final answered/missed outcome). Same rules as
 * processInboundCall: a known caller keeps their seller; a new caller is
 * round-robined and stuck. Returns the seller + their forward number.
 */
export async function getOrAssignSellerForCall(
  fromRaw: string,
  to: string,
): Promise<{
  line: { id: string; name: string; phoneE164: string };
  seller: { id: string; name: string; telegramUserId: string | null; phoneE164: string | null };
  isNewContact: boolean;
} | null> {
  const from = normalizeE164(fromRaw);
  if (!isValidE164(from)) return null;
  // STRICT match only — the account-wide telephony webhook sees EVERY call in
  // the company, and most numbers belong to other departments. A call to a
  // number that is not an explicitly configured line must be left untouched
  // (no fallback, no contact creation, no forward).
  const line = await prisma.line.findFirst({ where: { isActive: true, phoneE164: normalizeE164(to) } });
  if (!line) return null;

  const { sellerId, isNew } = await prisma.$transaction(async (t) => {
    const contact = await t.contact.findUnique({ where: { phoneE164_lineId: { phoneE164: from, lineId: line.id } } });
    if (!contact) {
      const s = await assignNextSeller(t, line.id);
      await t.contact.create({
        data: { phoneE164: from, lineId: line.id, assignedSellerId: s.id, status: 'active', firstMessageAt: new Date(), lastMessageAt: new Date() },
      });
      return { sellerId: s.id, isNew: true };
    }
    let sid = contact.assignedSellerId;
    if (!sid) {
      const s = await assignNextSeller(t, line.id);
      sid = s.id;
    }
    await t.contact.update({ where: { id: contact.id }, data: { assignedSellerId: sid, lastMessageAt: new Date() } });
    return { sellerId: sid, isNew: false };
  });

  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, name: true, telegramUserId: true, phoneE164: true },
  });
  if (!seller) return null;
  return { line: { id: line.id, name: line.name, phoneE164: line.phoneE164 }, seller, isNewContact: isNew };
}

export interface ProcessCallOpts {
  /** 'roundrobin' (app assigns) or 'answered' (queue mode: owner = who answered). */
  assignMode?: 'roundrobin' | 'answered';
  /** In 'answered' mode: the seller whose extension ANSWERED this call (from call-log legs). */
  answeredSellerId?: string | null;
}

/**
 * Process one INBOUND call: resolve the line (from the number that was called),
 * find/create the per-line contact, assign a seller (same client -> same seller;
 * new client -> round-robin, or in queue mode the seller who ANSWERED), record
 * the call (answered/missed/duration — regardless of outcome), and privately
 * notify the assigned seller. Idempotent by ringcentral_call_id.
 */
export async function processInboundCall(call: InboundCall, opts: ProcessCallOpts = {}): Promise<CallResult> {
  const from = normalizeE164(call.from);
  if (!isValidE164(from)) {
    return { status: 'rejected', reason: 'invalid_from_phone' };
  }

  const line = await resolveLineByNumber(call.to);
  if (!line) {
    return { status: 'rejected', reason: 'no_line_configured' };
  }

  // Idempotency: never record the same call twice.
  if (call.ringcentralCallId) {
    const existing = await prisma.call.findUnique({ where: { ringcentralCallId: call.ringcentralCallId } });
    if (existing) {
      return { status: 'duplicate', callId: existing.id, lineId: line.id, sellerId: existing.sellerId ?? undefined };
    }
  }

  const result = normalizeCallResult(call.result);
  const mode = opts.assignMode ?? config.callAssignMode;

  const tx = await prisma.$transaction(async (t) => {
    let contact = await t.contact.findUnique({
      where: { phoneE164_lineId: { phoneE164: from, lineId: line.id } },
    });
    let isNewContact = false;
    let sellerId: string | null;
    let sellerName: string | undefined;

    // Picks the owner for an ownerless contact. In 'answered' (queue) mode the
    // queue already distributed the call — the seller who ANSWERED becomes the
    // owner; a missed call leaves the contact unassigned (the queue re-rotates
    // next time). In 'roundrobin' mode the app assigns the next seller itself.
    const pickSeller = async (): Promise<{ id: string; name: string } | null> => {
      if (mode === 'answered') {
        if (!opts.answeredSellerId) return null;
        const s = await t.seller.findUnique({ where: { id: opts.answeredSellerId } });
        return s ? { id: s.id, name: s.name } : null;
      }
      return assignNextSeller(t, line.id);
    };

    if (!contact) {
      isNewContact = true;
      const seller = await pickSeller();
      sellerId = seller?.id ?? null;
      sellerName = seller?.name;
      contact = await t.contact.create({
        data: { phoneE164: from, lineId: line.id, assignedSellerId: sellerId, status: 'active', firstMessageAt: new Date(), lastMessageAt: new Date() },
      });
      logger.info(Decision.NEW_CLIENT_CREATED, { via: 'call', contactId: contact.id, phone: from, lineId: line.id, sellerId, mode });
      await writeAudit(
        { actorType: 'system', action: Decision.NEW_CLIENT_CREATED, entityType: 'contact', entityId: contact.id, details: { via: 'call', phone: from, lineId: line.id, sellerId, mode } },
        t,
      );
    } else {
      if (!contact.assignedSellerId) {
        const seller = await pickSeller();
        if (seller) {
          contact = await t.contact.update({ where: { id: contact.id }, data: { assignedSellerId: seller.id } });
        }
      }
      sellerId = contact.assignedSellerId ?? null;
      if (sellerId) {
        const seller = await t.seller.findUnique({ where: { id: sellerId } });
        sellerName = seller?.name ?? 'seller';
        logger.info(Decision.EXISTING_SELLER_REUSED, { via: 'call', contactId: contact.id, phone: from, lineId: line.id, sellerId });
      }
      await t.contact.update({ where: { id: contact.id }, data: { lastMessageAt: new Date() } });
    }

    const callRow = await t.call.create({
      data: {
        lineId: line.id,
        contactId: contact.id,
        sellerId,
        direction: 'inbound',
        result,
        durationSec: call.durationSec ?? null,
        ringcentralCallId: call.ringcentralCallId ?? null,
        startedAt: call.startedAt ? new Date(call.startedAt) : new Date(),
        rawPayloadJson: JSON.stringify(call),
      },
    });

    logger.info('inbound_call_recorded', { callId: callRow.id, contactId: contact.id, lineId: line.id, sellerId, result, isNewContact });
    return { contact, callRow, sellerId, sellerName, isNewContact };
  });

  // Notify the assigned seller privately (queue mode may leave a missed call
  // from a brand-new caller unowned — nothing to notify then).
  let notified = false;
  if (tx.sellerId) {
    const seller = await prisma.seller.findUnique({ where: { id: tx.sellerId } });
    if (seller?.telegramUserId) {
      const text = formatCallNotification(from, result, call.durationSec, { name: line.name, phone: line.phoneE164 });
      const topicId = await getSellerLineTopic(tx.sellerId, line.id);
      const sent = await sendTelegramMessage(seller.telegramUserId, text, { messageThreadId: topicId ?? undefined });
      if (sent.ok && sent.messageId) {
        notified = true;
        await prisma.call.update({
          where: { id: tx.callRow.id },
          data: { telegramMessageId: sent.messageId, telegramChatId: sent.chatId },
        });
        logger.info(Decision.TELEGRAM_NOTIFIED, { via: 'call', sellerId: tx.sellerId, callId: tx.callRow.id });
      } else {
        logger.error('telegram_notify_failed', { via: 'call', sellerId: tx.sellerId, error: sent.error });
      }
    } else {
      logger.warn('seller_has_no_telegram', { sellerId: tx.sellerId });
    }
  }

  return {
    status: 'processed',
    callId: tx.callRow.id,
    lineId: line.id,
    sellerId: tx.sellerId ?? undefined,
    sellerName: tx.sellerName,
    result,
    isNewContact: tx.isNewContact,
    notified,
  };
}
