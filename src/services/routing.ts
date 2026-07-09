import { Tx } from '../db';
import { logger, Decision } from '../logger';

export class NoActiveSellersError extends Error {
  constructor(lineId: string) {
    super(`No active sellers available on line ${lineId}.`);
    this.name = 'NoActiveSellersError';
  }
}

/** Get (or create) the routing_state cursor for a specific line. */
async function getOrCreateRoutingState(tx: Tx, lineId: string) {
  const existing = await tx.routingState.findUnique({ where: { lineId } });
  if (existing) return existing;
  return tx.routingState.create({ data: { lineId, mode: 'round_robin' } });
}

/**
 * Round-robin the next active seller ON A SPECIFIC LINE (team).
 *
 * - Active sellers of that line, ordered by priority ASC, id ASC.
 * - Reads the line's routing_state.last_seller_id and picks the one AFTER it
 *   (wrapping). If null/inactive, picks the first active seller of the line.
 * - Updates the line's cursor + the seller's last_assigned_at.
 *
 * With a single seller on the line this always returns that seller — which is
 * exactly the "each seller has their own number, fully separate" setup.
 *
 * MUST run inside a transaction so the per-line read-modify-write is atomic.
 */
export async function assignNextSeller(tx: Tx, lineId: string): Promise<{ id: string; name: string }> {
  const active = await tx.seller.findMany({
    where: { isActive: true, lineId },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });

  if (active.length === 0) {
    throw new NoActiveSellersError(lineId);
  }

  const state = await getOrCreateRoutingState(tx, lineId);

  let next = active[0];
  if (state.lastSellerId) {
    const idx = active.findIndex((s) => s.id === state.lastSellerId);
    next = idx === -1 ? active[0] : active[(idx + 1) % active.length];
  }

  await tx.routingState.update({ where: { id: state.id }, data: { lastSellerId: next.id } });
  await tx.seller.update({ where: { id: next.id }, data: { lastAssignedAt: new Date() } });

  logger.info(Decision.SELLER_ASSIGNED, { lineId, sellerId: next.id, sellerName: next.name, mode: 'round_robin' });
  return { id: next.id, name: next.name };
}
