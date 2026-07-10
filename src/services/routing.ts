import { prisma, Tx } from '../db';
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
  // Preferred source of truth: SellerLine memberships (a seller may serve many
  // lines). Fall back to the legacy Seller.lineId column so a deploy that hasn't
  // been re-seeded yet still routes.
  const memberships = await tx.sellerLine.findMany({
    where: { lineId, isActive: true, seller: { isActive: true } },
    orderBy: [{ priority: 'asc' }, { sellerId: 'asc' }],
    include: { seller: { select: { id: true, name: true } } },
  });

  const active = memberships.length
    ? memberships.map((m) => m.seller)
    : await tx.seller.findMany({
        where: { isActive: true, lineId },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true },
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

/**
 * The Telegram forum topic (message_thread_id) a seller's inbound from a given
 * line should be posted into. Null when the seller has no per-line topic set
 * (plain private chat or the group's General thread).
 */
export async function getSellerLineTopic(sellerId: string, lineId: string): Promise<string | null> {
  const membership = await prisma.sellerLine.findUnique({
    where: { sellerId_lineId: { sellerId, lineId } },
    select: { telegramTopicId: true },
  });
  return membership?.telegramTopicId ?? null;
}
