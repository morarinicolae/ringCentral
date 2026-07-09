import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed 3 test sellers + the routing_state singleton.
 *
 * Set each seller's telegram_user_id to a REAL Telegram user id (the numeric id
 * of the person who will receive that seller's notifications) so private
 * notifications actually arrive. For local testing without a bot, the values
 * below are placeholders; the in-memory Telegram mock still records outbox
 * messages so the flow is fully testable.
 *
 * Override via env, e.g.:
 *   SELLER1_TELEGRAM_ID=123 SELLER2_TELEGRAM_ID=456 SELLER3_TELEGRAM_ID=789 npm run seed
 */
const SELLERS = [
  { name: 'Seller One', telegramUserId: process.env.SELLER1_TELEGRAM_ID ?? '1000001', priority: 10 },
  { name: 'Seller Two', telegramUserId: process.env.SELLER2_TELEGRAM_ID ?? '1000002', priority: 20 },
  { name: 'Seller Three', telegramUserId: process.env.SELLER3_TELEGRAM_ID ?? '1000003', priority: 30 },
];

async function main() {
  for (const s of SELLERS) {
    await prisma.seller.upsert({
      where: { telegramUserId: s.telegramUserId },
      update: { name: s.name, priority: s.priority, isActive: true },
      create: { name: s.name, telegramUserId: s.telegramUserId, priority: s.priority, isActive: true },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded seller: ${s.name} (telegram ${s.telegramUserId}, priority ${s.priority})`);
  }

  const existingState = await prisma.routingState.findFirst();
  if (!existingState) {
    await prisma.routingState.create({ data: { mode: 'round_robin' } });
    // eslint-disable-next-line no-console
    console.log('Seeded routing_state (round_robin).');
  }

  const total = await prisma.seller.count();
  // eslint-disable-next-line no-console
  console.log(`Done. ${total} sellers in DB.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
