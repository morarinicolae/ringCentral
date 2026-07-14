import { prisma } from '../db';
import { createForumTopic, deleteForumTopic, sendTelegramMessage } from './telegram';
import { logger } from '../logger';

/**
 * Per-client Telegram topics: every client gets their OWN forum topic inside
 * the owner seller's group (named after their phone number). All notifications
 * (SMS + calls) for that client land in that topic, and anything the team
 * writes inside the topic goes back to that client — a thread per client.
 *
 * Only applies when the seller's Telegram target is a GROUP (negative chat id)
 * with Topics enabled; otherwise returns null and callers fall back to the
 * per-line topic / plain chat.
 */
export async function ensureClientTopic(
  contactId: string,
  clientPhone: string,
  seller: { telegramUserId: string | null },
): Promise<string | null> {
  if (!seller.telegramUserId || !seller.telegramUserId.startsWith('-')) return null;
  const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { telegramTopicId: true } });
  if (contact?.telegramTopicId) return contact.telegramTopicId;
  const topicId = await createForumTopic(seller.telegramUserId, clientPhone);
  if (!topicId) return null;
  await prisma.contact.update({ where: { id: contactId }, data: { telegramTopicId: topicId } });
  logger.info('client_topic_created', { contactId, clientPhone, topicId });
  return topicId;
}

/**
 * Move a client's per-client topic when the client is reassigned to another
 * seller. A forum topic lives inside ONE group, so a reassignment can't "move"
 * the thread across groups — instead we DELETE the old topic in the old seller's
 * group and CREATE a fresh one in the new seller's group, then repoint
 * `contact.telegramTopicId`. Best-effort: Telegram failures (e.g. missing
 * "Manage Topics" permission) are logged, not thrown, and the stale topic id is
 * cleared regardless so a later message can't land in the wrong group.
 */
export async function migrateClientTopic(
  contactId: string,
  clientPhone: string,
  oldSeller: { name?: string; telegramUserId: string | null } | null,
  newSeller: { name?: string; telegramUserId: string | null },
  oldTopicId: string | null,
): Promise<string | null> {
  // Remove the old topic from the previous seller's group.
  if (oldTopicId && oldSeller?.telegramUserId?.startsWith('-')) {
    await deleteForumTopic(oldSeller.telegramUserId, oldTopicId);
  }
  // Always clear it — even if the delete failed or the new seller isn't a group,
  // a stale id belonging to the old group must never be reused for the new one.
  await prisma.contact.update({ where: { id: contactId }, data: { telegramTopicId: null } });

  // Recreate in the new seller's group (only if the new target is a group).
  if (!newSeller.telegramUserId?.startsWith('-')) {
    logger.info('client_topic_migrated', { contactId, from: oldSeller?.telegramUserId, to: newSeller.telegramUserId, oldTopicId, newTopicId: null });
    return null;
  }
  const topicId = await createForumTopic(newSeller.telegramUserId, clientPhone);
  if (!topicId) return null;
  await prisma.contact.update({ where: { id: contactId }, data: { telegramTopicId: topicId } });
  await sendTelegramMessage(
    newSeller.telegramUserId,
    `📎 Client mutat aici (${clientPhone})${oldSeller?.name ? ` de la ${oldSeller.name}` : ''}. Toate mesajele și apelurile de la acest client ajung în acest topic.`,
    { messageThreadId: topicId },
  );
  logger.info('client_topic_migrated', { contactId, from: oldSeller?.telegramUserId, to: newSeller.telegramUserId, oldTopicId, newTopicId: topicId });
  return topicId;
}
