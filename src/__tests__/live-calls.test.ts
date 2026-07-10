import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, inbound, TEST_LINE_NUMBER } from './helpers';
import { getOrAssignSellerForCall } from '../services/calls';
import { prisma } from '../db';

/**
 * Live call transfer resolves the sticky owner + their forward number BEFORE
 * forwarding the ringing call. Same sticky rules as recorded calls, unified
 * with SMS.
 */
describe('live call sticky assignment (getOrAssignSellerForCall)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedSellers(3);
  });

  it('a new caller is round-robined and returned with their forward (mobile) number', async () => {
    await prisma.seller.updateMany({ where: { name: 'Seller 1' }, data: { phoneE164: '+15551110001' } });
    const r = await getOrAssignSellerForCall('+15550000001', TEST_LINE_NUMBER);
    expect(r?.seller.name).toBe('Seller 1');
    expect(r?.seller.phoneE164).toBe('+15551110001');
    expect(r?.isNewContact).toBe(true);
  });

  it('a caller who TEXTED first reaches the SAME seller on a call (unified sticky)', async () => {
    const sms = await inbound('+15550000005', 'hi'); // Seller 1
    await inbound('+15550000006', 'hi2'); // Seller 2 (advance round-robin)
    const call = await getOrAssignSellerForCall('+15550000005', TEST_LINE_NUMBER);
    expect(call?.seller.id).toBe(sms.result.sellerId);
    expect(call?.isNewContact).toBe(false);
  });

  it('the same caller always resolves to the same seller (sticky across calls)', async () => {
    const first = await getOrAssignSellerForCall('+15550000009', TEST_LINE_NUMBER);
    await getOrAssignSellerForCall('+15550000010', TEST_LINE_NUMBER); // advance rr
    const again = await getOrAssignSellerForCall('+15550000009', TEST_LINE_NUMBER);
    expect(again?.seller.id).toBe(first?.seller.id);
  });

  it('returns null when no line is configured at all', async () => {
    await resetDb(); // wipe: no lines/sellers
    const r = await getOrAssignSellerForCall('+15550000001', TEST_LINE_NUMBER);
    expect(r).toBeNull();
  });
});
