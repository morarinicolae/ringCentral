import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, TEST_LINE_NUMBER } from './helpers';
import { processInboundCall } from '../services/calls';
import { prisma } from '../db';

/**
 * Queue mode (CALL_ASSIGN_MODE=answered): the RingCentral queue distributes new
 * callers; ownership follows whoever ANSWERED. Missed first calls stay
 * unassigned; once owned, a client never changes seller (sticky) even if the
 * queue misroutes a later call.
 */
describe('queue mode: ownership = who answered', () => {
  let sellers: Awaited<ReturnType<typeof seedSellers>>;

  beforeEach(async () => {
    await resetDb();
    sellers = await seedSellers(2);
  });

  it('a NEW caller answered by seller 2 becomes seller 2’s client (no round-robin)', async () => {
    const res = await processInboundCall(
      { from: '+15550000001', to: TEST_LINE_NUMBER, ringcentralCallId: 'Q1', result: 'Accepted', durationSec: 20 },
      { assignMode: 'answered', answeredSellerId: sellers[1].id },
    );
    expect(res.sellerId).toBe(sellers[1].id);
    const contact = await prisma.contact.findFirst({ where: { phoneE164: '+15550000001' } });
    expect(contact?.assignedSellerId).toBe(sellers[1].id);
  });

  it('a MISSED first call stays unassigned; the next ANSWERED call sets the owner', async () => {
    const missed = await processInboundCall(
      { from: '+15550000002', to: TEST_LINE_NUMBER, ringcentralCallId: 'Q2', result: 'Missed' },
      { assignMode: 'answered', answeredSellerId: null },
    );
    expect(missed.sellerId).toBeUndefined();
    expect((await prisma.contact.findFirst({ where: { phoneE164: '+15550000002' } }))?.assignedSellerId).toBeNull();

    const answered = await processInboundCall(
      { from: '+15550000002', to: TEST_LINE_NUMBER, ringcentralCallId: 'Q3', result: 'Accepted' },
      { assignMode: 'answered', answeredSellerId: sellers[0].id },
    );
    expect(answered.sellerId).toBe(sellers[0].id);
    expect((await prisma.contact.findFirst({ where: { phoneE164: '+15550000002' } }))?.assignedSellerId).toBe(sellers[0].id);
  });

  it('sticky wins: an owned client stays with their seller even if someone else answers later', async () => {
    await processInboundCall(
      { from: '+15550000003', to: TEST_LINE_NUMBER, ringcentralCallId: 'Q4', result: 'Accepted' },
      { assignMode: 'answered', answeredSellerId: sellers[0].id },
    );
    // Queue misroutes the second call and seller 2 answers — ownership must NOT move.
    const second = await processInboundCall(
      { from: '+15550000003', to: TEST_LINE_NUMBER, ringcentralCallId: 'Q5', result: 'Accepted' },
      { assignMode: 'answered', answeredSellerId: sellers[1].id },
    );
    expect(second.sellerId).toBe(sellers[0].id);
    expect(second.isNewContact).toBe(false);
  });
});
