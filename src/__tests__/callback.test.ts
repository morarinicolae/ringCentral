import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, inbound, buildReply } from './helpers';
import { processSellerReply } from '../services/reply';
import { prisma } from '../db';

/**
 * /call — replying to a client notification calls the client back via RingOut
 * (seller's mobile first, client sees the line number). TEST_MODE: no real call.
 */
describe('/call callback command', () => {
  let sellers: Awaited<ReturnType<typeof seedSellers>>;

  beforeEach(async () => {
    await resetDb();
    sellers = await seedSellers(2);
    await prisma.seller.update({ where: { id: sellers[0].id }, data: { phoneE164: '+15551110001' } });
  });

  it('assigned seller replying /call gets the TEST MODE bridge summary', async () => {
    const a = await inbound('+15550000001', 'call me back'); // -> Seller 1
    const res = await processSellerReply(buildReply(sellers[0].telegramUserId, a.notificationMessageId, '/call'));
    expect(res.outcome).toBe('test_sent');
    expect(res.replyText).toContain('+15550000001'); // client
    expect(res.replyText).toContain('+15551110001'); // seller mobile
  });

  it('a seller without a mobile set is told to add one', async () => {
    await inbound('+15550000001', 'x'); // S1
    const b = await inbound('+15550000002', 'y'); // S2 (no phone set)
    const res = await processSellerReply(buildReply(sellers[1].telegramUserId, b.notificationMessageId, '/call'));
    expect(res.outcome).toBe('failed');
    expect(res.replyText).toContain('Mobil');
  });

  it('privacy: /call on another seller’s notification id does not resolve', async () => {
    await inbound('+15550000001', 'x'); // S1
    const b = await inbound('+15550000002', 'y'); // S2
    const res = await processSellerReply(buildReply(sellers[0].telegramUserId, b.notificationMessageId, '/call'));
    expect(res.outcome).toBe('unknown_context');
  });

  it('/call without replying to a notification is rejected', async () => {
    const res = await processSellerReply(buildReply(sellers[0].telegramUserId, undefined, '/call'));
    expect(res.outcome).toBe('no_context');
  });
});
