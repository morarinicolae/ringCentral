import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, inbound, buildReply } from './helpers';
import { processSellerReply } from '../services/reply';
import { telegramOutbox } from '../services/telegram';
import { prisma } from '../db';

describe('seller reply flow', () => {
  let sellers: Awaited<ReturnType<typeof seedSellers>>;

  beforeEach(async () => {
    await resetDb();
    sellers = await seedSellers(3);
  });

  it('Test 5 (reply): assigned seller reply is prepared only for their client (TEST_MODE)', async () => {
    // Client B -> Seller 2 (advance to second).
    await inbound('+15550000001', 'A hi'); // S1
    const b = await inbound('+15550000002', 'B hi'); // S2
    expect(b.result.sellerName).toBe('Seller 2');

    const reply = buildReply(sellers[1].telegramUserId, b.notificationMessageId, 'Sure, how can I help?');
    const res = await processSellerReply(reply);

    expect(res.outcome).toBe('test_sent');
    const outbound = await prisma.message.findFirst({ where: { direction: 'outbound' } });
    expect(outbound?.status).toBe('test_sent');
    // The confirmation went back to Seller 2's chat and references Client B only.
    const confirmation = telegramOutbox[telegramOutbox.length - 1];
    expect(confirmation.chatId).toBe(sellers[1].telegramUserId);
    expect(confirmation.text).toContain('TEST MODE');
  });

  it('Test 6: a seller CANNOT reply to a conversation they do not own', async () => {
    // Client A -> Seller 1. Seller 1 keeps the notification in their chat.
    const a = await inbound('+15550000001', 'A hi');
    // The conversation is then reassigned to Seller 2 (e.g. by an admin). Seller
    // 1's old notification is now stale — a reply to it must be blocked.
    await prisma.conversation.update({ where: { id: a.result.conversationId! }, data: { assignedSellerId: sellers[1].id } });
    await prisma.contact.update({ where: { id: a.result.contactId! }, data: { assignedSellerId: sellers[1].id } });

    const reply = buildReply(sellers[0].telegramUserId, a.notificationMessageId, 'I will take this');
    const res = await processSellerReply(reply);

    expect(res.outcome).toBe('blocked_ownership');
    // No outbound message created.
    expect(await prisma.message.count({ where: { direction: 'outbound' } })).toBe(0);
    // An unauthorized-reply audit row exists.
    expect(await prisma.auditLog.count({ where: { action: 'unauthorized_reply_blocked' } })).toBe(1);
  });

  it('privacy: a seller cannot resolve another seller’s notification from their own chat', async () => {
    await inbound('+15550000001', 'A hi'); // Client A -> Seller 1
    const b = await inbound('+15550000002', 'B hi'); // Client B -> Seller 2

    // Seller 1 references Seller 2's notification message id, but from Seller 1's
    // chat. Telegram message ids are per-chat, so this never resolves to B's
    // conversation — the reply is rejected and nothing is sent.
    const reply = buildReply(sellers[0].telegramUserId, b.notificationMessageId, 'take B');
    const res = await processSellerReply(reply);

    expect(res.outcome).toBe('unknown_context');
    expect(await prisma.message.count({ where: { direction: 'outbound' } })).toBe(0);
  });

  it('Test 7: free-text without reply context is blocked (no guessing)', async () => {
    await inbound('+15550000002', 'B hi'); // Seller 1

    const freeText = buildReply(sellers[0].telegramUserId, undefined, 'send this to my client');
    const res = await processSellerReply(freeText);

    expect(res.outcome).toBe('no_context');
    expect(res.replyText).toContain('reply to a specific client message');
    expect(await prisma.message.count({ where: { direction: 'outbound' } })).toBe(0);
  });

  it('a reply referencing an unknown message id is rejected, not guessed', async () => {
    await inbound('+15550000002', 'B hi');
    const res = await processSellerReply(buildReply(sellers[0].telegramUserId, '999999999', 'hello?'));
    expect(res.outcome).toBe('unknown_context');
    expect(await prisma.message.count({ where: { direction: 'outbound' } })).toBe(0);
  });

  it('an unregistered Telegram user is told they are not registered', async () => {
    await inbound('+15550000002', 'B hi');
    const res = await processSellerReply(buildReply('7777777', 'irrelevant', 'let me in'));
    expect(res.outcome).toBe('not_registered');
  });

  it('outbound message is recorded and linked to the correct conversation', async () => {
    const a = await inbound('+15550000005', 'need info'); // Seller 1
    const reply = buildReply(sellers[0].telegramUserId, a.notificationMessageId, 'Here is the info');
    const res = await processSellerReply(reply);
    expect(res.conversationId).toBe(a.result.conversationId);
    const outbound = await prisma.message.findFirst({ where: { direction: 'outbound' } });
    expect(outbound?.conversationId).toBe(a.result.conversationId);
    expect(outbound?.sellerId).toBe(sellers[0].id);
    expect(outbound?.body).toBe('Here is the info');
  });
});
