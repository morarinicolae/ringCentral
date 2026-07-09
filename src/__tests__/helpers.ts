import { prisma } from '../db';
import { ParsedTelegramMessage, resetTelegramOutbox } from '../services/telegram';
import { processInboundSms } from '../services/inbound';

let replyMessageCounter = 500000;

/** The company number the test line answers on (matches RINGCENTRAL_FROM_NUMBER). */
export const TEST_LINE_NUMBER = '+15550009999';

/** Wipe every table (FK-safe order) and the in-memory Telegram outbox. */
export async function resetDb(): Promise<void> {
  // Order matters: children before parents.
  await prisma.message.deleteMany();
  await prisma.call.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.routingState.deleteMany();
  await prisma.seller.deleteMany();
  await prisma.line.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.webhookEvent.deleteMany();
  resetTelegramOutbox();
}

export interface SeededSeller {
  id: string;
  name: string;
  telegramUserId: string;
}

/**
 * Seed one line (the test company number) with N active sellers on it, ascending
 * priority (10, 20, 30, ...) so round-robin order is deterministic:
 * Seller 1, Seller 2, Seller 3.
 */
export async function seedSellers(count = 3): Promise<SeededSeller[]> {
  const line = await prisma.line.create({
    data: { phoneE164: TEST_LINE_NUMBER, name: 'Test Line', isActive: true },
  });
  await prisma.routingState.create({ data: { lineId: line.id, mode: 'round_robin' } });

  const sellers: SeededSeller[] = [];
  for (let i = 1; i <= count; i++) {
    const s = await prisma.seller.create({
      data: {
        name: `Seller ${i}`,
        telegramUserId: `20000${i}`,
        priority: i * 10,
        isActive: true,
        lineId: line.id,
      },
    });
    sellers.push({ id: s.id, name: s.name, telegramUserId: s.telegramUserId! });
  }
  return sellers;
}

/** Seed a second line with its own single seller (for isolation/segmentation tests). */
export async function seedSecondLine(number: string, sellerTelegram = '299999') {
  const line = await prisma.line.create({ data: { phoneE164: number, name: 'Line B', isActive: true } });
  await prisma.routingState.create({ data: { lineId: line.id, mode: 'round_robin' } });
  const seller = await prisma.seller.create({
    data: { name: 'Seller B', telegramUserId: sellerTelegram, priority: 10, isActive: true, lineId: line.id },
  });
  return { line, seller };
}

/**
 * Run one inbound SMS through the full pipeline and return the processing
 * result plus the Telegram notification id/chat the seller would reply to.
 */
export async function inbound(from: string, text: string, ringcentralMessageId?: string, to: string = TEST_LINE_NUMBER) {
  const result = await processInboundSms({
    from,
    to,
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
