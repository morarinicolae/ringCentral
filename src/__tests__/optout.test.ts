import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, inbound, buildReply } from './helpers';
import { processSellerReply } from '../services/reply';
import { isOptOut } from '../services/optout';
import { prisma } from '../db';

describe('opt-out protection', () => {
  let sellers: Awaited<ReturnType<typeof seedSellers>>;

  beforeEach(async () => {
    await resetDb();
    sellers = await seedSellers(3);
  });

  it('detects opt-out keywords as standalone words', () => {
    expect(isOptOut('STOP')).toBe(true);
    expect(isOptOut('please STOP now')).toBe(true);
    expect(isOptOut('Unsubscribe')).toBe(true);
    expect(isOptOut('QUIT')).toBe(true);
    // No false positives on substrings.
    expect(isOptOut('my friend recommended you')).toBe(false);
    expect(isOptOut('stopwatch')).toBe(false);
    expect(isOptOut('I need help')).toBe(false);
  });

  it('Test 8: STOP from a client marks the contact opt_out', async () => {
    const c = await inbound('+15550000003', 'STOP');
    expect(c.result.optOut).toBe(true);
    const contact = await prisma.contact.findFirst({ where: { phoneE164: '+15550000003' } });
    expect(contact?.status).toBe('opt_out');
    // Opt-out is audited.
    expect(await prisma.auditLog.count({ where: { action: 'opt_out_detected' } })).toBe(1);
  });

  it('Test 9: a seller cannot send SMS to an opted-out contact', async () => {
    // First a normal message so the seller has a notification to reply to.
    const first = await inbound('+15550000003', 'hi there'); // Seller 1
    // Then the client opts out.
    await inbound('+15550000003', 'STOP');

    const reply = buildReply(sellers[0].telegramUserId, first.notificationMessageId, 'Are you still there?');
    const res = await processSellerReply(reply);

    expect(res.outcome).toBe('blocked_opt_out');
    expect(res.replyText).toContain('opted out');
    // No outbound SMS message row should be created for the blocked send.
    expect(await prisma.message.count({ where: { direction: 'outbound' } })).toBe(0);
  });
});
