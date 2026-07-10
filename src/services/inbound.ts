import { prisma } from '../db';
import { logger, Decision } from '../logger';
import { InboundSms } from '../types';
import { normalizeE164, isValidE164 } from './phone';
import { isOptOut } from './optout';
import { assignNextSeller, getSellerLineTopic } from './routing';
import { resolveLineByNumber } from './lines';
import { writeAudit } from './audit';
import { sendTelegramMessage, formatInboundNotification, formatOptOutNotification } from './telegram';
import { ensureClientTopic } from './client-topics';

export interface InboundResult {
  status: 'processed' | 'duplicate' | 'rejected';
  reason?: string;
  duplicate?: boolean;
  lineId?: string;
  lineName?: string;
  contactId?: string;
  conversationId?: string;
  messageId?: string;
  sellerId?: string;
  sellerName?: string;
  isNewContact?: boolean;
  optOut?: boolean;
  notified?: boolean;
}

/**
 * Full inbound pipeline for one SMS: validate -> resolve the LINE (from the
 * company number it was sent to) -> message-level idempotency -> per-line
 * contact lookup/create (+ round-robin among that line's sellers for new
 * clients) -> save message -> opt-out handling -> private Telegram notification
 * to the assigned seller only.
 */
export async function processInboundSms(inbound: InboundSms): Promise<InboundResult> {
  const from = normalizeE164(inbound.from);
  const body = inbound.text ?? '';

  if (!isValidE164(from)) {
    logger.warn('inbound_rejected_invalid_from', { from: inbound.from });
    return { status: 'rejected', reason: 'invalid_from_phone' };
  }

  const line = await resolveLineByNumber(inbound.to);
  if (!line) {
    logger.error('inbound_rejected_no_line', { to: inbound.to });
    return { status: 'rejected', reason: 'no_line_configured' };
  }

  // Message-level idempotency (rule 1).
  if (inbound.ringcentralMessageId) {
    const existing = await prisma.message.findUnique({
      where: { ringcentralMessageId: inbound.ringcentralMessageId },
    });
    if (existing) {
      logger.info(Decision.DUPLICATE_WEBHOOK, { ringcentralMessageId: inbound.ringcentralMessageId, messageId: existing.id });
      return { status: 'duplicate', duplicate: true, messageId: existing.id, conversationId: existing.conversationId };
    }
  }

  const optedOut = isOptOut(body);

  const tx = await prisma.$transaction(async (t) => {
    let contact = await t.contact.findUnique({
      where: { phoneE164_lineId: { phoneE164: from, lineId: line.id } },
    });
    let isNewContact = false;
    let sellerId: string;
    let sellerName: string;

    if (!contact) {
      // NEW client on this line -> round-robin among the line's team.
      isNewContact = true;
      const seller = await assignNextSeller(t, line.id);
      sellerId = seller.id;
      sellerName = seller.name;

      contact = await t.contact.create({
        data: {
          phoneE164: from,
          lineId: line.id,
          assignedSellerId: sellerId,
          status: optedOut ? 'opt_out' : 'active',
          firstMessageAt: new Date(),
          lastMessageAt: new Date(),
        },
      });
      logger.info(Decision.NEW_CLIENT_CREATED, { contactId: contact.id, phone: from, lineId: line.id, sellerId });
      await writeAudit(
        { actorType: 'system', action: Decision.NEW_CLIENT_CREATED, entityType: 'contact', entityId: contact.id, details: { phone: from, lineId: line.id, sellerId } },
        t,
      );
    } else {
      // EXISTING client on this line -> reuse the assigned seller. Never re-route.
      if (!contact.assignedSellerId) {
        const seller = await assignNextSeller(t, line.id);
        contact = await t.contact.update({ where: { id: contact.id }, data: { assignedSellerId: seller.id } });
      }
      sellerId = contact.assignedSellerId!;
      const seller = await t.seller.findUnique({ where: { id: sellerId } });
      sellerName = seller?.name ?? 'seller';
      logger.info(Decision.EXISTING_SELLER_REUSED, { contactId: contact.id, phone: from, lineId: line.id, sellerId });
      await t.contact.update({ where: { id: contact.id }, data: { lastMessageAt: new Date() } });
    }

    let conversation = await t.conversation.findFirst({
      where: { contactId: contact.id, status: 'open' },
      orderBy: { createdAt: 'desc' },
    });
    if (!conversation) {
      conversation = await t.conversation.create({
        data: { contactId: contact.id, lineId: line.id, assignedSellerId: sellerId, status: 'open', lastMessageAt: new Date() },
      });
    } else {
      await t.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    }

    if (optedOut && contact.status !== 'opt_out') {
      contact = await t.contact.update({ where: { id: contact.id }, data: { status: 'opt_out' } });
    }

    const message = await t.message.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        lineId: line.id,
        sellerId,
        direction: 'inbound',
        body,
        ringcentralMessageId: inbound.ringcentralMessageId ?? null,
        status: 'received',
        rawPayloadJson: JSON.stringify(inbound),
      },
    });

    logger.info(Decision.INBOUND_RECEIVED, { messageId: message.id, contactId: contact.id, conversationId: conversation.id, lineId: line.id, sellerId, optedOut });

    if (optedOut) {
      logger.info(Decision.OPT_OUT_DETECTED, { contactId: contact.id, phone: from });
      await writeAudit(
        { actorType: 'system', action: Decision.OPT_OUT_DETECTED, entityType: 'contact', entityId: contact.id, details: { phone: from } },
        t,
      );
    }

    return { contact, conversation, message, sellerId, sellerName, isNewContact };
  });

  // --- Notify the assigned seller privately (outside the DB transaction) ---
  const seller = await prisma.seller.findUnique({ where: { id: tx.sellerId } });
  let notified = false;
  if (!seller?.telegramUserId) {
    logger.warn('seller_has_no_telegram', { sellerId: tx.sellerId });
  } else {
    const lineInfo = { name: line.name, phone: line.phoneE164 };
    const text = optedOut ? formatOptOutNotification(from, body, lineInfo) : formatInboundNotification(from, body, lineInfo);
    // Per-client topic first (thread per client in the seller's group), then
    // the per-line topic, then the plain chat.
    const topicId =
      (await ensureClientTopic(tx.contact.id, from, seller)) ?? (await getSellerLineTopic(tx.sellerId, line.id));
    const sent = await sendTelegramMessage(seller.telegramUserId, text, { messageThreadId: topicId ?? undefined });
    if (sent.ok && sent.messageId) {
      notified = true;
      await prisma.message.update({
        where: { id: tx.message.id },
        data: { telegramMessageId: sent.messageId, telegramChatId: sent.chatId, status: 'forwarded_to_seller' },
      });
      logger.info(Decision.TELEGRAM_NOTIFIED, { sellerId: tx.sellerId, messageId: tx.message.id, telegramMessageId: sent.messageId });
    } else {
      logger.error('telegram_notify_failed', { sellerId: tx.sellerId, error: sent.error });
    }
  }

  return {
    status: 'processed',
    lineId: line.id,
    lineName: line.name,
    contactId: tx.contact.id,
    conversationId: tx.conversation.id,
    messageId: tx.message.id,
    sellerId: tx.sellerId,
    sellerName: tx.sellerName,
    isNewContact: tx.isNewContact,
    optOut: optedOut,
    notified,
  };
}
