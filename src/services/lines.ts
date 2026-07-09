import { prisma, Tx } from '../db';
import { config } from '../config';
import { normalizeE164 } from './phone';

/**
 * Resolve which Line an inbound SMS/call belongs to, from the company number it
 * was sent TO. Falls back to the configured RINGCENTRAL_FROM_NUMBER line, then
 * to the first active line. Returns null only if no lines exist at all.
 */
export async function resolveLineByNumber(
  toNumber: string | null | undefined,
  client: Tx | typeof prisma = prisma,
): Promise<{ id: string; phoneE164: string; name: string } | null> {
  const to = normalizeE164(toNumber ?? '');
  if (to) {
    const line = await client.line.findUnique({ where: { phoneE164: to } });
    if (line) return line;
  }
  // Fallback: the line for the configured company number.
  const from = normalizeE164(config.ringcentral.fromNumber);
  if (from) {
    const line = await client.line.findUnique({ where: { phoneE164: from } });
    if (line) return line;
  }
  // Last resort: the first active line.
  return client.line.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
}
