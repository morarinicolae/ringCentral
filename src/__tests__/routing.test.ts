import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers, inbound } from './helpers';

describe('round-robin assignment', () => {
  beforeEach(async () => {
    await resetDb();
    await seedSellers(3);
  });

  it('Test 1: first new client -> Seller 1', async () => {
    const { result } = await inbound('+15550000001', 'Hello A');
    expect(result.isNewContact).toBe(true);
    expect(result.sellerName).toBe('Seller 1');
  });

  it('Tests 1-3: three new clients -> Seller 1, 2, 3 in order', async () => {
    const a = await inbound('+15550000001', 'Hello A');
    const b = await inbound('+15550000002', 'Hello B');
    const c = await inbound('+15550000003', 'Hello C');
    expect(a.result.sellerName).toBe('Seller 1');
    expect(b.result.sellerName).toBe('Seller 2');
    expect(c.result.sellerName).toBe('Seller 3');
  });

  it('Test 3 (wrap): fourth NEW client loops back to Seller 1', async () => {
    await inbound('+15550000001', 'Hello A');
    await inbound('+15550000002', 'Hello B');
    await inbound('+15550000003', 'Hello C');
    const d = await inbound('+15550000004', 'Hello D'); // new client #4
    expect(d.result.sellerName).toBe('Seller 1');
  });

  it('Test 4: an existing client always goes to the same seller (no re-route)', async () => {
    const first = await inbound('+15550000001', 'Hello A'); // Seller 1
    await inbound('+15550000002', 'Hello B'); // Seller 2 (advances round-robin)
    const again = await inbound('+15550000001', 'Second message from A');
    expect(again.result.isNewContact).toBe(false);
    expect(again.result.sellerId).toBe(first.result.sellerId);
    expect(again.result.sellerName).toBe('Seller 1');
  });

  it('does not advance round-robin for existing clients', async () => {
    await inbound('+15550000001', 'A1'); // S1
    await inbound('+15550000001', 'A2'); // still S1, must NOT consume S2
    const b = await inbound('+15550000002', 'B1');
    expect(b.result.sellerName).toBe('Seller 2');
  });

  it('skips inactive sellers and wraps correctly', async () => {
    // Deactivate Seller 2 via DB; new clients should go S1 -> S3 -> S1 ...
    const { prisma } = await import('../db');
    const s2 = await prisma.seller.findFirst({ where: { name: 'Seller 2' } });
    await prisma.seller.update({ where: { id: s2!.id }, data: { isActive: false } });

    const a = await inbound('+15550000001', 'A');
    const b = await inbound('+15550000002', 'B');
    const c = await inbound('+15550000003', 'C');
    expect(a.result.sellerName).toBe('Seller 1');
    expect(b.result.sellerName).toBe('Seller 3');
    expect(c.result.sellerName).toBe('Seller 1');
  });
});
