import { Tx } from '../db';
import { logger, Decision } from '../logger';

export class NoActiveSellersError extends Error {
  constructor() {
    super('No active sellers available for assignment.');
    this.name = 'NoActiveSellersError';
  }
}

/** Get the singleton routing_state row, creating it on first use. */
async function getOrCreateRoutingState(tx: Tx) {
  const existing = await tx.routingState.findFirst();
  if (existing) return existing;
  return tx.routingState.create({ data: { mode: 'round_robin' } });
}

/**
 * Round-robin selection of the next active seller.
 *
 * - Active sellers are ordered by priority ASC, id ASC.
 * - We read routing_state.last_seller_id and pick the seller AFTER it (wrapping).
 * - If last_seller_id is null or no longer active, we pick the first active seller.
 * - routing_state.last_seller_id is updated ONLY here (i.e. only for a new client),
 *   and seller.last_assigned_at is stamped.
 *
 * MUST be called inside a transaction so the read-modify-write on routing_state
 * cannot interleave with a concurrent assignment.
 */
export async function assignNextSeller(tx: Tx): Promise<{ id: string; name: string }> {
  const active = await tx.seller.findMany({
    where: { isActive: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });

  if (active.length === 0) {
    throw new NoActiveSellersError();
  }

  const state = await getOrCreateRoutingState(tx);

  let next = active[0];
  if (state.lastSellerId) {
    const idx = active.findIndex((s) => s.id === state.lastSellerId);
    if (idx === -1) {
      // last seller is inactive / removed -> start from the first active seller.
      next = active[0];
    } else {
      next = active[(idx + 1) % active.length];
    }
  }

  await tx.routingState.update({
    where: { id: state.id },
    data: { lastSellerId: next.id },
  });
  await tx.seller.update({
    where: { id: next.id },
    data: { lastAssignedAt: new Date() },
  });

  logger.info(Decision.SELLER_ASSIGNED, { sellerId: next.id, sellerName: next.name, mode: 'round_robin' });
  return { id: next.id, name: next.name };
}
