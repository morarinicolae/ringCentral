import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, seedSecondLine, inbound, TEST_LINE_NUMBER } from './helpers';
import { processInboundCall } from '../services/calls';
import { telegramOutbox } from '../services/telegram';
import { prisma } from '../db';

describe('inbound call distribution', () => {
  let sellers: Awaited<ReturnType<typeof seedSellers>>;

  beforeEach(async () => {
    await resetDb();
    sellers = await seedSellers(3);
  });

  it('a new caller is round-robined, recorded, and the seller is notified', async () => {
    const res = await processInboundCall({ from: '+15550000001', to: TEST_LINE_NUMBER, ringcentralCallId: 'C1', result: 'Accepted', durationSec: 42 });
    expect(res.status).toBe('processed');
    expect(res.sellerName).toBe('Seller 1');
    expect(res.result).toBe('answered');
    expect(res.notified).toBe(true);

    const call = await prisma.call.findFirst({ where: { ringcentralCallId: 'C1' } });
    expect(call?.result).toBe('answered');
    expect(call?.durationSec).toBe(42);
    expect(call?.sellerId).toBe(sellers[0].id);
  });

  it('a MISSED call is still assigned + recorded (regardless of outcome)', async () => {
    const res = await processInboundCall({ from: '+15550000002', to: TEST_LINE_NUMBER, ringcentralCallId: 'C2', result: 'Missed', durationSec: 0 });
    expect(res.result).toBe('missed');
    const call = await prisma.call.findFirst({ where: { ringcentralCallId: 'C2' } });
    expect(call?.result).toBe('missed');
    expect(call?.sellerId).toBeTruthy();
  });

  it('the same caller always goes to the same seller (calls)', async () => {
    const first = await processInboundCall({ from: '+15550000001', to: TEST_LINE_NUMBER, ringcentralCallId: 'C3', result: 'Accepted' });
    await processInboundCall({ from: '+15550000009', to: TEST_LINE_NUMBER, ringcentralCallId: 'C3b', result: 'Accepted' }); // advance rr
    const again = await processInboundCall({ from: '+15550000001', to: TEST_LINE_NUMBER, ringcentralCallId: 'C4', result: 'Missed' });
    expect(again.sellerId).toBe(first.sellerId);
    expect(again.isNewContact).toBe(false);
  });

  it('unified ownership: a client who TEXTED, then CALLS, reaches the same seller', async () => {
    const sms = await inbound('+15550000005', 'hi'); // Seller 1
    await inbound('+15550000006', 'hi2'); // Seller 2 (advance rr for SMS)
    const call = await processInboundCall({ from: '+15550000005', to: TEST_LINE_NUMBER, ringcentralCallId: 'C5', result: 'Accepted' });
    expect(call.sellerId).toBe(sms.result.sellerId);
    expect(call.isNewContact).toBe(false);
  });

  it('call idempotency: the same RingCentral call id is not recorded twice', async () => {
    await processInboundCall({ from: '+15550000007', to: TEST_LINE_NUMBER, ringcentralCallId: 'DUP', result: 'Accepted' });
    const dup = await processInboundCall({ from: '+15550000007', to: TEST_LINE_NUMBER, ringcentralCallId: 'DUP', result: 'Accepted' });
    expect(dup.status).toBe('duplicate');
    expect(await prisma.call.count({ where: { ringcentralCallId: 'DUP' } })).toBe(1);
  });
});

describe('segmentation + isolation (each seller = own number)', () => {
  let sellers: Awaited<ReturnType<typeof seedSellers>>;
  const LINE_B = '+15550008888';

  beforeEach(async () => {
    await resetDb();
    // Line A = TEST_LINE_NUMBER with Seller 1/2/3.
    sellers = await seedSellers(3);
    // Line B = its own number with its own single Seller B.
    await seedSecondLine(LINE_B);
  });

  it('the SAME phone on two different numbers = two separate contacts + sellers, never crossing', async () => {
    // Same client phone texts BOTH company numbers.
    const onA = await inbound('+15550001234', 'to line A', undefined, TEST_LINE_NUMBER);
    const onB = await inbound('+15550001234', 'to line B', undefined, LINE_B);

    expect(onA.result.lineName).toBe('Test Line');
    expect(onB.result.lineName).toBe('Line B');
    // Different sellers, on different lines — X never reaches the other line's seller.
    expect(onA.result.sellerName).toBe('Seller 1');
    expect(onB.result.sellerName).toBe('Seller B');
    expect(onA.result.sellerId).not.toBe(onB.result.sellerId);

    // Two distinct contacts (one per line).
    expect(await prisma.contact.count({ where: { phoneE164: '+15550001234' } })).toBe(2);
  });

  it('a call to Line B goes to Seller B, never to Line A sellers', async () => {
    const res = await processInboundCall({ from: '+15550005555', to: LINE_B, ringcentralCallId: 'CB1', result: 'Accepted' });
    expect(res.sellerName).toBe('Seller B');
    // None of Line A's sellers got it.
    expect(sellers.map((s) => s.id)).not.toContain(res.sellerId);
  });

  it('privacy: a seller only sees their OWN calls', async () => {
    await processInboundCall({ from: '+15550001111', to: TEST_LINE_NUMBER, ringcentralCallId: 'PA', result: 'Accepted' }); // Seller 1
    await processInboundCall({ from: '+15550002222', to: LINE_B, ringcentralCallId: 'PB', result: 'Accepted' }); // Seller B

    const seller1Calls = await prisma.call.findMany({ where: { sellerId: sellers[0].id } });
    expect(seller1Calls.every((c) => c.ringcentralCallId !== 'PB')).toBe(true);
    expect(seller1Calls.some((c) => c.ringcentralCallId === 'PA')).toBe(true);
  });
});
