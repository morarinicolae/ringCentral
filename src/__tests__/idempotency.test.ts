import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, seedSellers } from './helpers';
import { ingestInbounds } from '../services/ingest';
import { processInboundSms } from '../services/inbound';
import { telegramOutbox } from '../services/telegram';
import { prisma } from '../db';

describe('webhook idempotency', () => {
  beforeEach(async () => {
    await resetDb();
    await seedSellers(3);
  });

  it('Test 5: duplicate RingCentral webhook does not create a duplicate Telegram message', async () => {
    const inbound = { from: '+15550000001', to: '+15550009999', text: 'Hello, I need help' };

    const first = await ingestInbounds('ringcentral', [inbound], inbound);
    expect(first.status).toBe('processed');

    const second = await ingestInbounds('ringcentral', [inbound], inbound);
    expect(second.status).toBe('duplicate');

    // Exactly ONE notification, ONE inbound message, ONE webhook event stored.
    expect(telegramOutbox.length).toBe(1);
    expect(await prisma.message.count({ where: { direction: 'inbound' } })).toBe(1);
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it('dedupes by ringcentral_message_id even if envelope differs', async () => {
    const a = { from: '+15550000002', to: '+15550009999', text: 'first', ringcentralMessageId: 'RC-123' };
    const b = { from: '+15550000002', to: '+15550009999', text: 'DIFFERENT text', ringcentralMessageId: 'RC-123' };

    await processInboundSms(a);
    const dup = await processInboundSms(b);

    expect(dup.status).toBe('duplicate');
    expect(telegramOutbox.length).toBe(1);
    expect(await prisma.message.count({ where: { direction: 'inbound' } })).toBe(1);
  });

  it('distinct messages from the same client are NOT deduped', async () => {
    await ingestInbounds('ringcentral', [{ from: '+15550000003', to: '+15550009999', text: 'msg one' }], {});
    await ingestInbounds('ringcentral', [{ from: '+15550000003', to: '+15550009999', text: 'msg two' }], {});
    expect(telegramOutbox.length).toBe(2);
    expect(await prisma.message.count({ where: { direction: 'inbound' } })).toBe(2);
  });
});
