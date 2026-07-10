import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, addSellerToLine, setSellerLineTopic, inbound, buildReply, TEST_LINE_NUMBER } from './helpers';
import { processInboundCall } from '../services/calls';
import { processSellerReply } from '../services/reply';
import { telegramOutbox } from '../services/telegram';
import { prisma } from '../db';

/**
 * "One group per seller, one topic per number": a seller serves several company
 * numbers, and each number's inbound lands in its own forum topic inside the
 * seller's Telegram group (message_thread_id).
 */
describe('per-number Telegram topics (one group per seller)', () => {
  const LINE_B = '+15550007777';
  let sellerId: string;

  beforeEach(async () => {
    await resetDb();
    const [seller] = await seedSellers(1); // one seller = one group (telegram_user_id)
    sellerId = seller.id;
    // The seller serves TWO numbers; each maps to its own topic in their group.
    const lineA = await prisma.line.findUniqueOrThrow({ where: { phoneE164: TEST_LINE_NUMBER } });
    await setSellerLineTopic(sellerId, lineA.id, '111'); // topic for number 1
    const lineB = await prisma.line.create({ data: { phoneE164: LINE_B, name: 'Number 2', isActive: true } });
    await prisma.routingState.create({ data: { lineId: lineB.id, mode: 'round_robin' } });
    await addSellerToLine(sellerId, lineB.id, '222'); // topic for number 2
  });

  it('SMS on number 1 → topic 111, SMS on number 2 → topic 222, same group', async () => {
    await inbound('+15550001234', 'hi from 1', undefined, TEST_LINE_NUMBER);
    await inbound('+15550009876', 'hi from 2', undefined, LINE_B);

    const a = telegramOutbox.find((o) => o.text.includes('hi from 1'));
    const b = telegramOutbox.find((o) => o.text.includes('hi from 2'));
    expect(a?.messageThreadId).toBe('111');
    expect(b?.messageThreadId).toBe('222');
    // Both notifications go to the SAME seller group.
    expect(a?.chatId).toBe(b?.chatId);
  });

  it('a call on number 2 is posted into that number’s topic', async () => {
    await processInboundCall({ from: '+15550005555', to: LINE_B, ringcentralCallId: 'TOPIC_CALL', result: 'Missed' });
    const call = telegramOutbox.find((o) => o.text.includes('Missed call'));
    expect(call?.messageThreadId).toBe('222');
    expect(call?.chatId).toBe('200001'); // Seller 1's group id (from seedSellers)
  });

  it('a team member replying FROM THE GROUP (not a private chat) answers the client, in the topic', async () => {
    // Client on number 1 -> assigned to the seller, notification posted in topic 111.
    const a = await inbound('+15550001234', 'need help', undefined, TEST_LINE_NUMBER);
    // A human on the team replies inside the group topic (fromId != group id).
    const groupId = '200001'; // Seller 1's telegram target (the team group)
    const reply = buildReply(groupId, a.notificationMessageId, 'Bună, cu ce vă ajut?', {
      fromId: '987654321', // a personal user id of a team member
      isPrivateChat: false,
      messageThreadId: '111',
    });
    const res = await processSellerReply(reply);
    expect(res.outcome).toBe('test_sent'); // TEST_MODE — recorded, not really sent
    expect(res.conversationId).toBe(a.result.conversationId);
    // Confirmation goes back into the SAME group + topic.
    const confirmation = telegramOutbox[telegramOutbox.length - 1];
    expect(confirmation.chatId).toBe(groupId);
    expect(confirmation.messageThreadId).toBe('111');
  });

  it('a reply from the WRONG group cannot answer another team’s client', async () => {
    // Seller 1's client (number 1).
    const a = await inbound('+15550001234', 'need help', undefined, TEST_LINE_NUMBER);
    // Add a second, unrelated seller/group.
    const other = await prisma.seller.create({ data: { name: 'Other team', telegramUserId: '-100999', priority: 50, isActive: true } });
    await prisma.sellerLine.create({ data: { sellerId: other.id, lineId: (await prisma.line.findFirstOrThrow({ where: { phoneE164: TEST_LINE_NUMBER } })).id, priority: 50, isActive: true } });
    // The other group tries to reply to Seller 1's notification id — never resolves in their chat.
    const reply = buildReply('-100999', a.notificationMessageId, 'we will take it', { fromId: '111', isPrivateChat: false });
    const res = await processSellerReply(reply);
    expect(res.outcome).toBe('unknown_context');
    expect(await prisma.message.count({ where: { direction: 'outbound' } })).toBe(0);
  });

  it('with no topic set, inbound still delivers (no message_thread_id)', async () => {
    // A fresh seller/line pair without a topic → posts to the group General thread.
    const other = await prisma.line.create({ data: { phoneE164: '+15550006666', name: 'No topic', isActive: true } });
    await prisma.routingState.create({ data: { lineId: other.id, mode: 'round_robin' } });
    await addSellerToLine(sellerId, other.id); // no topic
    await inbound('+15550004321', 'no topic here', undefined, '+15550006666');
    const msg = telegramOutbox.find((o) => o.text.includes('no topic here'));
    expect(msg).toBeTruthy();
    expect(msg?.messageThreadId).toBeUndefined();
  });
});
