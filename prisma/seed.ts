import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed lines + sellers. Supports both setups:
 *
 *  SHARED (one number, round-robin between sellers) — the default:
 *    set SELLER1_TELEGRAM_ID + SELLER2_TELEGRAM_ID (+ SELLER3_...) and ONE
 *    LINE1_NUMBER. All sellers land on Line 1 -> new clients alternate
 *    1->Seller1, 2->Seller2, 3->Seller1... and stay with their seller.
 *
 *  SEGMENTED (each seller their own number):
 *    also set LINE2_NUMBER (+ LINE3_NUMBER). Then Seller 2 goes on Line 2, etc.
 *
 * Env: LINEn_NUMBER, LINEn_NAME, SELLERn_NAME, SELLERn_TELEGRAM_ID (n = 1..3).
 * Line 1 defaults to RINGCENTRAL_FROM_NUMBER.
 */
const FROM = process.env.RINGCENTRAL_FROM_NUMBER ?? '+10000000001';
const LINE1_NUMBER = process.env.LINE1_NUMBER ?? FROM;
const LINE1_NAME = process.env.LINE1_NAME ?? 'Sales';

interface Row {
  sellerName: string;
  sellerTelegram: string;
  lineNumber: string;
  lineName: string;
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (let n = 1; n <= 3; n++) {
    const tg = process.env[`SELLER${n}_TELEGRAM_ID`] ?? (n === 1 ? '1000001' : undefined);
    if (!tg) continue;
    // Seller n gets its own line only if LINEn_NUMBER is set; otherwise it
    // shares Line 1 (round-robin).
    const lineNumber = process.env[`LINE${n}_NUMBER`] ?? LINE1_NUMBER;
    const lineName = process.env[`LINE${n}_NAME`] ?? (lineNumber === LINE1_NUMBER ? LINE1_NAME : `Line ${n}`);
    rows.push({
      sellerName: process.env[`SELLER${n}_NAME`] ?? `Seller ${n}`,
      sellerTelegram: tg,
      lineNumber,
      lineName,
    });
  }
  return rows;
}

async function main() {
  const rows = buildRows();
  let priority = 10;

  for (const r of rows) {
    const line = await prisma.line.upsert({
      where: { phoneE164: r.lineNumber },
      update: { name: r.lineName, isActive: true },
      create: { phoneE164: r.lineNumber, name: r.lineName, isActive: true },
    });
    const rs = await prisma.routingState.findUnique({ where: { lineId: line.id } });
    if (!rs) await prisma.routingState.create({ data: { lineId: line.id, mode: 'round_robin' } });

    await prisma.seller.upsert({
      where: { telegramUserId: r.sellerTelegram },
      update: { name: r.sellerName, priority, isActive: true, lineId: line.id },
      create: { name: r.sellerName, telegramUserId: r.sellerTelegram, priority, isActive: true, lineId: line.id },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded ${r.sellerName} (telegram ${r.sellerTelegram}) on line "${r.lineName}" (${r.lineNumber})`);
    priority += 10;
  }

  // eslint-disable-next-line no-console
  console.log(`Done. ${await prisma.line.count()} line(s), ${await prisma.seller.count()} seller(s).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
