import { config } from '../config';
import { logger } from '../logger';

export interface TelegramSendResult {
  ok: boolean;
  messageId?: string;
  chatId: string;
  error?: string;
}

// In-memory outbox used when TELEGRAM_BOT_TOKEN is unset (local dev + tests).
// Lets tests assert exactly what the bot "sent" without any network.
export interface OutboxItem {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  messageId: string;
}
export const telegramOutbox: OutboxItem[] = [];
let mockMessageCounter = 1000;
export function resetTelegramOutbox(): void {
  telegramOutbox.length = 0;
  mockMessageCounter = 1000;
}

const usingMock = () => !config.telegram.botToken;

/**
 * Send a Telegram message to a private chat.
 * `chatId` is the seller's private chat id (== their telegram_user_id for a
 * 1:1 chat with the bot). We NEVER send to group chats.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  opts: { replyToMessageId?: string } = {},
): Promise<TelegramSendResult> {
  if (usingMock()) {
    const messageId = String(++mockMessageCounter);
    telegramOutbox.push({ chatId, text, replyToMessageId: opts.replyToMessageId, messageId });
    logger.debug('telegram_mock_send', { chatId, messageId, text });
    return { ok: true, messageId, chatId };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // reply_to_message_id keeps the seller's thread anchored to the client
        // notification; the seller replies to that message to answer the client.
        ...(opts.replyToMessageId ? { reply_to_message_id: Number(opts.replyToMessageId) } : {}),
        disable_web_page_preview: true,
      }),
    });
    const json = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!json.ok || !json.result) {
      return { ok: false, chatId, error: json.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, messageId: String(json.result.message_id), chatId };
  } catch (err) {
    return { ok: false, chatId, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Telegram update parsing --------------------------------------------

export interface ParsedTelegramMessage {
  updateId?: number;
  chatId: string;
  fromId: string;
  text: string;
  messageId: string;
  replyToMessageId?: string;
  isPrivateChat: boolean;
}

/**
 * Parse a Telegram update into the fields we care about. Returns null for
 * updates we don't handle (edited messages, callbacks, non-message updates).
 */
export function parseTelegramUpdate(update: any): ParsedTelegramMessage | null {
  const message = update?.message;
  if (!message || typeof message.text !== 'string') return null;
  if (!message.from?.id || !message.chat?.id) return null;

  return {
    updateId: update.update_id,
    chatId: String(message.chat.id),
    fromId: String(message.from.id),
    text: message.text,
    messageId: String(message.message_id),
    replyToMessageId: message.reply_to_message?.message_id
      ? String(message.reply_to_message.message_id)
      : undefined,
    isPrivateChat: message.chat.type === 'private',
  };
}

/** Format the inbound-client notification a seller receives. */
export function formatInboundNotification(clientPhone: string, body: string): string {
  return ['New SMS assigned to you', '', `Client: ${clientPhone}`, 'Message:', `“${body}”`, '', 'To reply, reply directly to this Telegram message.'].join(
    '\n',
  );
}

/** Format the notification when an inbound message is an opt-out (STOP etc.). */
export function formatOptOutNotification(clientPhone: string, body: string): string {
  return [
    '⚠️ Client opted out',
    '',
    `Client: ${clientPhone}`,
    'Message:',
    `“${body}”`,
    '',
    'This client has opted out. You cannot send SMS to them.',
  ].join('\n');
}

/** Format the inbound-call notification a seller receives. */
export function formatCallNotification(clientPhone: string, result: string, durationSec?: number): string {
  const icon = result === 'missed' ? '📵' : result === 'voicemail' ? '📩' : '📞';
  const label =
    result === 'missed'
      ? 'Missed call'
      : result === 'answered'
        ? 'Answered call'
        : result === 'voicemail'
          ? 'Voicemail'
          : 'Call';
  const dur = durationSec != null ? ` (${durationSec}s)` : '';
  return [`${icon} ${label}${dur}`, '', `Client: ${clientPhone}`, '', 'This caller is assigned to you.'].join('\n');
}
