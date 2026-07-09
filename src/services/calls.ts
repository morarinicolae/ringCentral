import { prisma } from '../db';
import { logger, Decision } from '../logger';
import { normalizeE164, isValidE164 } from './phone';
import { assignNextSeller } from './routing';
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
 * Process one INBOUND call: resolve the line (from the number that was called),
 * find/create the per-line contact, assign a seller (same client -> same seller,
 * new client -> round-robin among the line's team), record the call in the DB
 * (answered/missed/duration — regardless of outcome), and privately notify the
 * assigned seller. Idempotent by ringcentral_call_id.
 */
export async function processInboundCall(call: InboundCall): Promise<CallResult> {
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

  const tx = await prisma.$transaction(async (t) => {
    let contact = await t.contact.findUnique({
      where: { phoneE164_lineId: { phoneE164: from, lineId: line.id } },
    });
    let isNewContact = false;
    let sellerId: string;
    let sellerName: string;

    if (!contact) {
      isNewContact = true;
      const seller = await assignNextSeller(t, line.id);
      sellerId = seller.id;
      sellerName = seller.name;
      contact = await t.contact.create({
        data: { phoneE164: from, lineId: line.id, assignedSellerId: sellerId, status: 'active', firstMessageAt: new Date(), lastMessageAt: new Date() },
      });
      logger.info(Decision.NEW_CLIENT_CREATED, { via: 'call', contactId: contact.id, phone: from, lineId: line.id, sellerId });
      await writeAudit(
        { actorType: 'system', action: Decision.NEW_CLIENT_CREATED, entityType: 'contact', entityId: contact.id, details: { via: 'call', phone: from, lineId: line.id, sellerId } },
        t,
      );
    } else {
      if (!contact.assignedSellerId) {
        const seller = await assignNextSeller(t, line.id);
        contact = await t.contact.update({ where: { id: contact.id }, data: { assignedSellerId: seller.id } });
      }
      sellerId = contact.assignedSellerId!;
      const seller = await t.seller.findUnique({ where: { id: sellerId } });
      sellerName = seller?.name ?? 'seller';
      logger.info(Decision.EXISTING_SELLER_REUSED, { via: 'call', contactId: contact.id, phone: from, lineId: line.id, sellerId });
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

  // Notify the assigned seller privately.
  const seller = await prisma.seller.findUnique({ where: { id: tx.sellerId } });
  let notified = false;
  if (seller?.telegramUserId) {
    const text = formatCallNotification(from, result, call.durationSec);
    const sent = await sendTelegramMessage(seller.telegramUserId, text);
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

  return {
    status: 'processed',
    callId: tx.callRow.id,
    lineId: line.id,
    sellerId: tx.sellerId,
    sellerName: tx.sellerName,
    result,
    isNewContact: tx.isNewContact,
    notified,
  };
}
