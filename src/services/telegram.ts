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
  messageThreadId?: string;
  messageId: string;
}
export const telegramOutbox: OutboxItem[] = [];
let mockMessageCounter = 1000;
export function resetTelegramOutbox(): void {
  telegramOutbox.length = 0;
  mockMessageCounter = 1000;
}

const usingMock = () => !config.telegram.botToken;

// Mock forum topics (tests/dev without a bot token).
let mockTopicCounter = 9000;

/**
 * Create a forum TOPIC in a seller's group (per-client thread). Returns the
 * message_thread_id, or null when the chat is not a forum / bot lacks rights.
 * Requires the group to have Topics enabled and the bot to be an admin with
 * "Manage topics".
 */
export async function createForumTopic(chatId: string, name: string): Promise<string | null> {
  if (usingMock()) {
    return String(++mockTopicCounter);
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, name: name.slice(0, 128) }),
    });
    const json = (await res.json()) as { ok: boolean; result?: { message_thread_id: number }; description?: string };
    if (!json.ok || !json.result) {
      logger.warn('telegram_create_topic_failed', { chatId, name, error: json.description });
      return null;
    }
    return String(json.result.message_thread_id);
  } catch (err) {
    logger.warn('telegram_create_topic_failed', { chatId, name, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Delete a forum topic (and its messages) from a group. Used when a client is
 * reassigned to another seller: their per-client topic is removed from the old
 * seller's group and recreated in the new one. Requires the bot to have the
 * "Manage Topics" admin permission in that group. Best-effort — returns false
 * on failure instead of throwing, so a reassignment never blocks on it.
 */
export async function deleteForumTopic(chatId: string, threadId: string): Promise<boolean> {
  if (usingMock()) return true;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/deleteForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: Number(threadId) }),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) logger.warn('telegram_delete_topic_failed', { chatId, threadId, error: json.description });
    return Boolean(json.ok);
  } catch (err) {
    logger.warn('telegram_delete_topic_failed', { chatId, threadId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Send a Telegram message to a seller.
 * `chatId` is the seller's Telegram target — either a 1:1 chat id (== their
 * telegram_user_id) or a group/forum chat id (negative). `messageThreadId`, when
 * set, posts into a specific forum topic so a seller who serves several company
 * numbers gets each number in its own topic inside their group.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  opts: { replyToMessageId?: string; messageThreadId?: string } = {},
): Promise<TelegramSendResult> {
  if (usingMock()) {
    const messageId = String(++mockMessageCounter);
    telegramOutbox.push({ chatId, text, replyToMessageId: opts.replyToMessageId, messageThreadId: opts.messageThreadId, messageId });
    logger.debug('telegram_mock_send', { chatId, messageId, text, messageThreadId: opts.messageThreadId });
    return { ok: true, messageId, chatId };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // Post into a specific forum topic (per-number topic in the seller's group).
        ...(opts.messageThreadId ? { message_thread_id: Number(opts.messageThreadId) } : {}),
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
  // Forum topic (message_thread_id) the message is in, for group/forum chats.
  messageThreadId?: string;
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

  // In a forum, a plain message in a topic carries reply_to_message pointing at
  // the topic-creation service message. That is NOT a real reply to a
  // notification, so ignore it (only genuine replies count — rule: no guessing).
  const rt = message.reply_to_message;
  const isRealReply = rt?.message_id && !rt.forum_topic_created && rt.message_id !== message.message_thread_id;

  return {
    updateId: update.update_id,
    chatId: String(message.chat.id),
    fromId: String(message.from.id),
    text: message.text,
    messageId: String(message.message_id),
    replyToMessageId: isRealReply ? String(rt.message_id) : undefined,
    messageThreadId: message.message_thread_id != null ? String(message.message_thread_id) : undefined,
    isPrivateChat: message.chat.type === 'private',
  };
}

/** The company line a message/call arrived on — shown so a seller who serves
 * more than one number knows which one the client contacted. */
export interface LineInfo {
  name?: string;
  phone?: string;
}

/** Renders a "Line: <name> (<number>)" header, or '' when no line info given. */
function lineHeader(line?: LineInfo): string[] {
  if (!line?.phone && !line?.name) return [];
  const label = line.name && line.phone ? `${line.name} (${line.phone})` : line.name ?? line.phone ?? '';
  return [`Line: ${label}`];
}

/** Format the inbound-client notification a seller receives. */
export function formatInboundNotification(clientPhone: string, body: string, line?: LineInfo): string {
  return [
    'New SMS assigned to you',
    '',
    ...lineHeader(line),
    `Client: ${clientPhone}`,
    'Message:',
    `“${body}”`,
    '',
    'To reply, reply directly to this Telegram message.',
  ].join('\n');
}

/** Format the notification when an inbound message is an opt-out (STOP etc.). */
export function formatOptOutNotification(clientPhone: string, body: string, line?: LineInfo): string {
  return [
    '⚠️ Client opted out',
    '',
    ...lineHeader(line),
    `Client: ${clientPhone}`,
    'Message:',
    `“${body}”`,
    '',
    'This client has opted out. You cannot send SMS to them.',
  ].join('\n');
}

/** Format the inbound-call notification a seller receives. A missed call is a
 * CALLBACK TASK for the assigned seller (and only them): the client stays
 * theirs and they call back via /call. */
export function formatCallNotification(clientPhone: string, result: string, durationSec?: number, line?: LineInfo): string {
  const icon = result === 'missed' ? '📵' : result === 'voicemail' ? '📩' : '📞';
  const label =
    result === 'missed'
      ? 'Missed call — CALLBACK TASK'
      : result === 'answered'
        ? 'Answered call'
        : result === 'voicemail'
          ? 'Voicemail'
          : 'Call';
  const dur = durationSec != null ? ` (${durationSec}s)` : '';
  const footer =
    result === 'missed' || result === 'voicemail'
      ? 'This caller is assigned to YOU. Call them back: reply /call to this message.'
      : 'This caller is assigned to you.';
  return [`${icon} ${label}${dur}`, '', ...lineHeader(line), `Client: ${clientPhone}`, '', footer].join('\n');
}
