import { prisma } from '../db';
import { logger, Decision } from '../logger';
import { InboundSms } from '../types';
import { normalizeE164, isValidE164 } from './phone';
import { isOptOut } from './optout';
import { assignNextSeller } from './routing';
import { writeAudit } from './audit';
import {
  sendTelegramMessage,
  formatInboundNotification,
  formatOptOutNotification,
} from './telegram';

export interface InboundResult {
  status: 'processed' | 'duplicate' | 'rejected';
  reason?: string;
  duplicate?: boolean;
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
 * The full inbound pipeline for one incoming SMS:
 *   validate -> message-level idempotency -> (contact lookup/create +
 *   round-robin for new clients) -> save inbound message -> opt-out handling
 *   -> private Telegram notification to the assigned seller only.
 *
 * Webhook-level idempotency (webhook_events) is handled by the caller
 * (src/services/ingest.ts) BEFORE this runs; this function additionally guards
 * against a duplicate RingCentral message id so a re-delivered event never
 * creates a second message or a second Telegram notification.
 */
export async function processInboundSms(inbound: InboundSms): Promise<InboundResult> {
  const from = normalizeE164(inbound.from);
  const to = normalizeE164(inbound.to);
  const body = inbound.text ?? '';

  if (!isValidE164(from)) {
    logger.warn('inbound_rejected_invalid_from', { from: inbound.from });
    return { status: 'rejected', reason: 'invalid_from_phone' };
  }

  // Message-level idempotency (rule 1): if we've already stored this RC message
  // id, do not create a duplicate and do not re-notify the seller.
  if (inbound.ringcentralMessageId) {
    const existing = await prisma.message.findUnique({
      where: { ringcentralMessageId: inbound.ringcentralMessageId },
    });
    if (existing) {
      logger.info(Decision.DUPLICATE_WEBHOOK, {
        ringcentralMessageId: inbound.ringcentralMessageId,
        messageId: existing.id,
      });
      return { status: 'duplicate', duplicate: true, messageId: existing.id, conversationId: existing.conversationId };
    }
  }

  const optedOut = isOptOut(body);

  // Everything that mutates ownership/routing runs in one transaction so the
  // round-robin read-modify-write is atomic.
  const tx = await prisma.$transaction(async (t) => {
    let contact = await t.contact.findUnique({ where: { phoneE164: from } });
    let isNewContact = false;
    let sellerId: string;
    let sellerName: string;

    if (!contact) {
      // NEW client -> round-robin assignment.
      isNewContact = true;
      const seller = await assignNextSeller(t);
      sellerId = seller.id;
      sellerName = seller.name;

      contact = await t.contact.create({
        data: {
          phoneE164: from,
          assignedSellerId: sellerId,
          status: optedOut ? 'opt_out' : 'active',
          firstMessageAt: new Date(),
          lastMessageAt: new Date(),
        },
      });
      logger.info(Decision.NEW_CLIENT_CREATED, { contactId: contact.id, phone: from, sellerId });
      await writeAudit(
        { actorType: 'system', action: Decision.NEW_CLIENT_CREATED, entityType: 'contact', entityId: contact.id, details: { phone: from, sellerId } },
        t,
      );
    } else {
      // EXISTING client -> reuse the seller already assigned. Never re-route.
      if (!contact.assignedSellerId) {
        // Defensive: an existing contact with no seller (shouldn't happen) —
        // assign one now rather than dropping the message.
        const seller = await assignNextSeller(t);
        contact = await t.contact.update({ where: { id: contact.id }, data: { assignedSellerId: seller.id } });
      }
      sellerId = contact.assignedSellerId!;
      const seller = await t.seller.findUnique({ where: { id: sellerId } });
      sellerName = seller?.name ?? 'seller';
      logger.info(Decision.EXISTING_SELLER_REUSED, { contactId: contact.id, phone: from, sellerId });
      await t.contact.update({ where: { id: contact.id }, data: { lastMessageAt: new Date() } });
    }

    // Find an open conversation for this contact, else open a new one.
    let conversation = await t.conversation.findFirst({
      where: { contactId: contact.id, status: 'open' },
      orderBy: { createdAt: 'desc' },
    });
    if (!conversation) {
      conversation = await t.conversation.create({
        data: { contactId: contact.id, assignedSellerId: sellerId, status: 'open', lastMessageAt: new Date() },
      });
    } else {
      await t.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    }

    // Opt-out handling (rule 5): mark the contact and record it.
    if (optedOut && contact.status !== 'opt_out') {
      contact = await t.contact.update({ where: { id: contact.id }, data: { status: 'opt_out' } });
    }

    // Persist the inbound message.
    const message = await t.message.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        sellerId,
        direction: 'inbound',
        body,
        ringcentralMessageId: inbound.ringcentralMessageId ?? null,
        status: 'received',
        rawPayloadJson: JSON.stringify(inbound),
      },
    });

    logger.info(Decision.INBOUND_RECEIVED, { messageId: message.id, contactId: contact.id, conversationId: conversation.id, sellerId, optedOut });

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
    const text = optedOut
      ? formatOptOutNotification(from, body)
      : formatInboundNotification(from, body);
    const sent = await sendTelegramMessage(seller.telegramUserId, text);
    if (sent.ok && sent.messageId) {
      notified = true;
      // Store the notification's Telegram message id on the inbound message so a
      // seller's reply-to can be resolved back to this conversation.
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
