import { PrismaClient } from '@prisma/client';

// Single shared Prisma client. Prisma reads DATABASE_URL at construction time,
// so `config`/tests must set it before this module is imported.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function prismaLogLevels(): ('warn' | 'error')[] {
  // Quiet in tests: some flows deliberately hit unique-constraint violations
  // (duplicate webhooks) and handle them; logging them is just noise.
  if (process.env.NODE_ENV === 'test') return [];
  if (process.env.NODE_ENV === 'development') return ['warn', 'error'];
  return ['error'];
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: prismaLogLevels(),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// A Prisma transaction client (interactive transaction handle). Service
// functions accept this so they can compose inside a single transaction.
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
