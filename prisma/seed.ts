import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed LINES (a company number + its own team) and one seller per line.
 *
 * Matches the "each seller has their own number, fully separate" setup:
 *   Line 1 (number 1) -> Seller One   ·   Line 2 (number 2) -> Seller Two
 *
 * Configure via env (numbers must be E.164):
 *   LINE1_NUMBER, LINE1_NAME, SELLER1_NAME, SELLER1_TELEGRAM_ID
 *   LINE2_NUMBER, LINE2_NAME, SELLER2_NAME, SELLER2_TELEGRAM_ID   (optional)
 *
 * Line 1 defaults to RINGCENTRAL_FROM_NUMBER. Line 2 is only created if
 * LINE2_NUMBER is provided.
 */
interface LineSeed {
  number: string;
  lineName: string;
  sellerName: string;
  sellerTelegram: string;
}

function buildLines(): LineSeed[] {
  const lines: LineSeed[] = [];
  const l1 = process.env.LINE1_NUMBER ?? process.env.RINGCENTRAL_FROM_NUMBER ?? '+10000000001';
  lines.push({
    number: l1,
    lineName: process.env.LINE1_NAME ?? 'Line 1',
    sellerName: process.env.SELLER1_NAME ?? 'Seller One',
    sellerTelegram: process.env.SELLER1_TELEGRAM_ID ?? '1000001',
  });
  if (process.env.LINE2_NUMBER) {
    lines.push({
      number: process.env.LINE2_NUMBER,
      lineName: process.env.LINE2_NAME ?? 'Line 2',
      sellerName: process.env.SELLER2_NAME ?? 'Seller Two',
      sellerTelegram: process.env.SELLER2_TELEGRAM_ID ?? '1000002',
    });
  }
  return lines;
}

async function main() {
  const lines = buildLines();
  let priority = 10;

  for (const l of lines) {
    const line = await prisma.line.upsert({
      where: { phoneE164: l.number },
      update: { name: l.lineName, isActive: true },
      create: { phoneE164: l.number, name: l.lineName, isActive: true },
    });
    await prisma.seller.upsert({
      where: { telegramUserId: l.sellerTelegram },
      update: { name: l.sellerName, priority, isActive: true, lineId: line.id },
      create: { name: l.sellerName, telegramUserId: l.sellerTelegram, priority, isActive: true, lineId: line.id },
    });
    // Ensure the line has a routing cursor.
    const rs = await prisma.routingState.findUnique({ where: { lineId: line.id } });
    if (!rs) await prisma.routingState.create({ data: { lineId: line.id, mode: 'round_robin' } });

    // eslint-disable-next-line no-console
    console.log(`Seeded line "${l.lineName}" (${l.number}) -> ${l.sellerName} (telegram ${l.sellerTelegram})`);
    priority += 10;
  }

  // eslint-disable-next-line no-console
  console.log(`Done. ${await prisma.line.count()} lines, ${await prisma.seller.count()} sellers.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
