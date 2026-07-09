import { prisma } from '../db';
import { ParsedTelegramMessage, resetTelegramOutbox } from '../services/telegram';
import { processInboundSms } from '../services/inbound';

let replyMessageCounter = 500000;

/** Wipe every table (FK-safe order) and the in-memory Telegram outbox. */
export async function resetDb(): Promise<void> {
  // Order matters: children before parents.
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.routingState.deleteMany();
  await prisma.seller.deleteMany();
  resetTelegramOutbox();
}

export interface SeededSeller {
  id: string;
  name: string;
  telegramUserId: string;
}

/**
 * Seed N active sellers with ascending priority (10, 20, 30, ...) so their
 * round-robin order is deterministic: Seller 1, Seller 2, Seller 3.
 */
export async function seedSellers(count = 3): Promise<SeededSeller[]> {
  const sellers: SeededSeller[] = [];
  for (let i = 1; i <= count; i++) {
    const s = await prisma.seller.create({
      data: {
        name: `Seller ${i}`,
        telegramUserId: `20000${i}`,
        priority: i * 10,
        isActive: true,
      },
    });
    sellers.push({ id: s.id, name: s.name, telegramUserId: s.telegramUserId! });
  }
  return sellers;
}

/**
 * Run one inbound SMS through the full pipeline and return the processing
 * result plus the Telegram notification id/chat the seller would reply to.
 */
export async function inbound(from: string, text: string, ringcentralMessageId?: string) {
  const result = await processInboundSms({
    from,
    to: '+15550009999',
    text,
    ringcentralMessageId,
  });
  const notification = result.messageId
    ? await prisma.message.findUnique({ where: { id: result.messageId } })
    : null;
  return {
    result,
    notificationMessageId: notification?.telegramMessageId ?? undefined,
    notificationChatId: notification?.telegramChatId ?? undefined,
  };
}

/** Build a parsed Telegram reply-to message as if a seller replied to a notification. */
export function buildReply(
  sellerTelegramId: string,
  replyToMessageId: string | undefined,
  text: string,
  overrides: Partial<ParsedTelegramMessage> = {},
): ParsedTelegramMessage {
  return {
    updateId: ++replyMessageCounter,
    chatId: sellerTelegramId,
    fromId: sellerTelegramId,
    text,
    messageId: String(++replyMessageCounter),
    replyToMessageId,
    isPrivateChat: true,
    ...overrides,
  };
}
