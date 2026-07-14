import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, inbound, buildReply } from './helpers';
import { processSellerReply } from '../services/reply';
import { processInboundCall } from '../services/calls';
import { migrateClientTopic } from '../services/client-topics';
import { telegramOutbox } from '../services/telegram';
import { prisma } from '../db';
import { TEST_LINE_NUMBER } from './helpers';

/**
 * Per-client Telegram topics: each new client gets their own forum topic in the
 * owner seller's GROUP; notifications land there and anything typed in the
 * topic goes back to that client (no reply-to needed).
 */
describe('per-client topics (thread per client in the seller group)', () => {
  const GROUP = '-100777';
  let sellerId: string;

  beforeEach(async () => {
    await resetDb();
    const [s] = await seedSellers(1);
    sellerId = s.id;
    await prisma.seller.update({ where: { id: sellerId }, data: { telegramUserId: GROUP } });
  });

  it('a new client SMS creates a topic named after them and notifies inside it', async () => {
    await inbound('+15550001111', 'salut');
    const note = telegramOutbox.find((o) => o.text.includes('salut'));
    expect(note?.chatId).toBe(GROUP);
    expect(note?.messageThreadId).toBeTruthy();
    const contact = await prisma.contact.findFirst({ where: { phoneE164: '+15550001111' } });
    expect(contact?.telegramTopicId).toBe(note?.messageThreadId);
  });

  it('the SAME client keeps the SAME topic across SMS and calls', async () => {
    await inbound('+15550001111', 'primul');
    const t1 = (await prisma.contact.findFirst({ where: { phoneE164: '+15550001111' } }))?.telegramTopicId;
    await processInboundCall({ from: '+15550001111', to: TEST_LINE_NUMBER, ringcentralCallId: 'CT1', result: 'Missed' });
    const callNote = telegramOutbox.find((o) => o.text.includes('Missed call'));
    expect(callNote?.messageThreadId).toBe(t1);
  });

  it('typing in the client topic (no reply-to) sends the SMS to that client', async () => {
    await inbound('+15550001111', 'salut');
    const contact = await prisma.contact.findFirst({ where: { phoneE164: '+15550001111' } });
    const res = await processSellerReply(
      buildReply(GROUP, undefined, 'Răspuns direct din topic', {
        fromId: '999111',
        isPrivateChat: false,
        messageThreadId: contact!.telegramTopicId!,
      }),
    );
    expect(res.outcome).toBe('test_sent');
    const outbound = await prisma.message.findFirst({ where: { direction: 'outbound' } });
    expect(outbound?.contactId).toBe(contact!.id);
  });

  it('typing in an unrelated thread does NOT guess a client', async () => {
    await inbound('+15550001111', 'salut');
    const res = await processSellerReply(
      buildReply(GROUP, undefined, 'hello', { fromId: '999111', isPrivateChat: false, messageThreadId: '424242' }),
    );
    expect(res.outcome).toBe('no_context');
    expect(await prisma.message.count({ where: { direction: 'outbound' } })).toBe(0);
  });

  it('/call typed inside the client topic resolves that client', async () => {
    await prisma.seller.update({ where: { id: sellerId }, data: { phoneE164: '+15559990001' } });
    await inbound('+15550001111', 'salut');
    const contact = await prisma.contact.findFirst({ where: { phoneE164: '+15550001111' } });
    const res = await processSellerReply(
      buildReply(GROUP, undefined, '/call', { fromId: '999111', isPrivateChat: false, messageThreadId: contact!.telegramTopicId! }),
    );
    expect(res.outcome).toBe('test_sent');
    expect(res.replyText).toContain('+15550001111');
  });

  it('reassigning a client MOVES the topic to the new seller group (old id dropped, note posted)', async () => {
    const GROUP2 = '-100888';
    await inbound('+15550001111', 'salut');
    const contact = await prisma.contact.findFirst({ where: { phoneE164: '+15550001111' } });
    const oldTopic = contact!.telegramTopicId!;
    expect(oldTopic).toBeTruthy();

    telegramOutbox.length = 0; // isolate the migration output
    const newTopic = await migrateClientTopic(
      contact!.id,
      '+15550001111',
      { name: 'Ana', telegramUserId: GROUP },
      { name: 'Bogdan', telegramUserId: GROUP2 },
      oldTopic,
    );

    // A fresh topic in the NEW group, different from the old one.
    expect(newTopic).toBeTruthy();
    expect(newTopic).not.toBe(oldTopic);
    const moved = await prisma.contact.findFirst({ where: { phoneE164: '+15550001111' } });
    expect(moved?.telegramTopicId).toBe(newTopic);

    // A "moved here" note lands in the new group's new topic.
    const note = telegramOutbox.find((o) => o.chatId === GROUP2 && o.text.includes('mutat'));
    expect(note?.messageThreadId).toBe(newTopic);
  });

  it('reassigning to a 1:1 seller (not a group) just clears the stale topic id', async () => {
    await inbound('+15550001111', 'salut');
    const contact = await prisma.contact.findFirst({ where: { phoneE164: '+15550001111' } });
    expect(contact!.telegramTopicId).toBeTruthy();

    const newTopic = await migrateClientTopic(
      contact!.id,
      '+15550001111',
      { name: 'Ana', telegramUserId: GROUP },
      { name: 'Bogdan', telegramUserId: '424242' }, // 1:1 chat, not a group
      contact!.telegramTopicId!,
    );
    expect(newTopic).toBeNull();
    const cleared = await prisma.contact.findFirst({ where: { phoneE164: '+15550001111' } });
    expect(cleared?.telegramTopicId).toBeNull();
  });
});
