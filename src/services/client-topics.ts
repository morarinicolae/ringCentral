import { prisma } from '../db';
import { createForumTopic } from './telegram';
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
