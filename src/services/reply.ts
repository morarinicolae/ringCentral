import { config } from '../config';
import { prisma } from '../db';
import { logger, Decision } from '../logger';
import {
  MSG_NO_CONTEXT,
  MSG_NOT_REGISTERED,
  MSG_NOT_YOUR_CONVERSATION,
  MSG_OPTED_OUT,
  MSG_UNKNOWN_CONTEXT,
} from '../constants';
import { ParsedTelegramMessage, sendTelegramMessage } from './telegram';
import { sendSms } from './ringcentral';
import { writeAudit } from './audit';

export interface ReplyResult {
  handled: boolean;
  outcome:
    | 'sent'
    | 'test_sent'
    | 'failed'
    | 'blocked_opt_out'
    | 'blocked_ownership'
    | 'no_context'
    | 'unknown_context'
    | 'not_registered'
    | 'command'
    | 'ignored';
  replyText?: string;
  conversationId?: string;
  outboundMessageId?: string;
}

async function replyToSeller(chatId: string, text: string, replyToMessageId?: string, messageThreadId?: string): Promise<void> {
  await sendTelegramMessage(chatId, text, { replyToMessageId, messageThreadId });
}

/**
 * Handle one parsed Telegram message from a seller and, if it's a valid reply
 * to a client notification, turn it into an outbound SMS.
 *
 * Safety (rules 3, 4, 7):
 *   - Only registered sellers are handled.
 *   - A reply MUST be a Telegram reply-to that resolves to a conversation; a
 *     free-text message is rejected with a clear prompt (never guessed).
 *   - The seller must OWN the conversation, or the reply is blocked (privacy).
 *   - Opt-out / blocked / closed contacts cannot be messaged.
 *   - The actual send goes through sendSms(), which re-validates ownership.
 */
export async function processSellerReply(msg: ParsedTelegramMessage): Promise<ReplyResult> {
  // The seller's Telegram target — a 1:1 chat OR their team group — IS the
  // identity: notifications are posted to that chat id and replies come back
  // from it. In a private chat chatId == the seller's user id; in a group it's
  // the group id (a personal user id of a group member never matches a seller).
  const seller = await prisma.seller.findUnique({ where: { telegramUserId: msg.chatId } });
  const isAdmin = config.adminTelegramIds.includes(msg.fromId);
  const thread = msg.messageThreadId;

  // Lightweight helper commands. Echoes the ids needed to wire up a group:
  // the CHAT id (set as the seller's Telegram target) and the TOPIC id.
  if (msg.text.trim().startsWith('/')) {
    const help = [
      `Chat ID: ${msg.chatId}`,
      thread ? `Topic ID: ${thread}` : `Your user ID: ${msg.fromId}`,
      seller ? `This chat is the target for seller "${seller.name}".` : 'This chat is not yet linked to a seller.',
      'To answer a client, reply directly to one of the client message notifications I send here.',
    ].join('\n');
    await replyToSeller(msg.chatId, help, msg.messageId, thread);
    return { handled: true, outcome: 'command', replyText: help };
  }

  if (!seller && !isAdmin) {
    // Never spam an unrelated group the bot happens to be in.
    if (!msg.isPrivateChat) {
      logger.warn('telegram_unlinked_group_ignored', { chatId: msg.chatId });
      return { handled: false, outcome: 'ignored' };
    }
    await replyToSeller(msg.chatId, MSG_NOT_REGISTERED, msg.messageId, thread);
    logger.warn('telegram_unknown_sender', { fromId: msg.fromId, chatId: msg.chatId });
    return { handled: true, outcome: 'not_registered', replyText: MSG_NOT_REGISTERED };
  }

  // Rule 3: no blind replies. A reply must reference a specific notification.
  if (!msg.replyToMessageId) {
    await replyToSeller(msg.chatId, MSG_NO_CONTEXT, msg.messageId, thread);
    logger.info('reply_without_context_blocked', { fromId: msg.fromId });
    return { handled: true, outcome: 'no_context', replyText: MSG_NO_CONTEXT };
  }

  // Resolve the replied-to notification back to a conversation.
  const notification = await prisma.message.findFirst({
    where: { telegramChatId: msg.chatId, telegramMessageId: msg.replyToMessageId },
    orderBy: { createdAt: 'desc' },
  });
  if (!notification) {
    await replyToSeller(msg.chatId, MSG_UNKNOWN_CONTEXT, msg.messageId, thread);
    logger.info('reply_context_not_found', { fromId: msg.fromId, replyToMessageId: msg.replyToMessageId });
    return { handled: true, outcome: 'unknown_context', replyText: MSG_UNKNOWN_CONTEXT };
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: notification.conversationId },
    include: { contact: true, line: true },
  });
  if (!conversation || !conversation.contact) {
    await replyToSeller(msg.chatId, MSG_UNKNOWN_CONTEXT, msg.messageId, thread);
    return { handled: true, outcome: 'unknown_context', replyText: MSG_UNKNOWN_CONTEXT };
  }

  // Rule 7: the seller must own this conversation. An admin replying in their
  // own chat is only ever mapped to their own notifications, so ownership is
  // checked against the resolved seller id.
  const actingSellerId = seller?.id ?? conversation.assignedSellerId ?? undefined;
  if (!seller || conversation.assignedSellerId !== seller.id) {
    await replyToSeller(msg.chatId, MSG_NOT_YOUR_CONVERSATION, msg.messageId, thread);
    logger.warn(Decision.UNAUTHORIZED_REPLY, {
      fromId: msg.fromId,
      sellerId: seller?.id,
      conversationId: conversation.id,
      conversationOwner: conversation.assignedSellerId,
    });
    await writeAudit({
      actorType: seller ? 'seller' : 'admin',
      actorId: seller?.id ?? msg.fromId,
      action: Decision.UNAUTHORIZED_REPLY,
      entityType: 'conversation',
      entityId: conversation.id,
      details: { attemptedBy: msg.fromId, owner: conversation.assignedSellerId },
    });
    return { handled: true, outcome: 'blocked_ownership', replyText: MSG_NOT_YOUR_CONVERSATION, conversationId: conversation.id };
  }

  const contact = conversation.contact;

  // Rule 5: opt-out (and other non-sendable statuses) block the send.
  if (contact.status === 'opt_out') {
    await replyToSeller(msg.chatId, MSG_OPTED_OUT, msg.messageId, thread);
    logger.info('reply_to_opted_out_blocked', { conversationId: conversation.id, contactId: contact.id });
    return { handled: true, outcome: 'blocked_opt_out', replyText: MSG_OPTED_OUT, conversationId: conversation.id };
  }
  if (contact.status === 'blocked' || contact.status === 'closed') {
    const text = `This conversation is ${contact.status}. SMS cannot be sent.`;
    await replyToSeller(msg.chatId, text, msg.messageId, thread);
    return { handled: true, outcome: 'blocked_ownership', replyText: text, conversationId: conversation.id };
  }

  // Reply goes out FROM the line's own number, so the client sees the same
  // number they contacted.
  const fromNumber = conversation.line?.phoneE164 ?? config.ringcentral.fromNumber;

  // Record the outbound intent before sending.
  const outbound = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      contactId: contact.id,
      lineId: conversation.lineId,
      sellerId: seller.id,
      direction: 'outbound',
      body: msg.text,
      telegramMessageId: msg.messageId,
      telegramChatId: msg.chatId,
      status: 'pending_send',
    },
  });

  const result = await sendSms({
    from: fromNumber,
    to: contact.phoneE164,
    text: msg.text,
    conversationId: conversation.id,
    sellerId: seller.id,
  });

  await prisma.message.update({
    where: { id: outbound.id },
    data: {
      status: result.status,
      ringcentralMessageId: result.ringcentralMessageId ?? null,
      failureReason: result.failureReason ?? null,
      rawPayloadJson: result.raw ? JSON.stringify(result.raw) : null,
    },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });

  await writeAudit({
    actorType: 'seller',
    actorId: seller.id,
    action: result.ok ? 'outbound_sms_' + result.status : Decision.OUTBOUND_FAILED,
    entityType: 'message',
    entityId: outbound.id,
    details: { conversationId: conversation.id, to: contact.phoneE164, status: result.status, reason: result.failureReason },
  });

  // Confirm back to the seller (rule 13).
  let confirmation: string;
  let outcome: ReplyResult['outcome'];
  if (result.status === 'test_sent') {
    confirmation = `TEST MODE: SMS was not sent. Payload was logged.\n(Would send to ${contact.phoneE164})`;
    outcome = 'test_sent';
  } else if (result.ok) {
    confirmation = `SMS sent to ${contact.phoneE164}.`;
    outcome = 'sent';
  } else {
    confirmation = `❌ SMS to ${contact.phoneE164} FAILED: ${result.failureReason ?? 'unknown error'}`;
    outcome = 'failed';
  }
  await replyToSeller(msg.chatId, confirmation, msg.messageId, thread);

  logger.info('seller_reply_processed', { conversationId: conversation.id, outboundMessageId: outbound.id, outcome, actingSellerId });
  return { handled: true, outcome, replyText: confirmation, conversationId: conversation.id, outboundMessageId: outbound.id };
}
