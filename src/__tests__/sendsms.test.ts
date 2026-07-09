import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, seedSellers, inbound, buildReply } from './helpers';
import { processSellerReply } from '../services/reply';
import { telegramOutbox } from '../services/telegram';
import { sendSms, _resetRingCentralToken } from '../services/ringcentral';
import { config } from '../config';
import { prisma } from '../db';

describe('outbound SMS sending', () => {
  let sellers: Awaited<ReturnType<typeof seedSellers>>;

  beforeEach(async () => {
    await resetDb();
    sellers = await seedSellers(3);
    _resetRingCentralToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    config.allowRealSms = false; // restore TEST_MODE default
  });

  it('Test 11: TEST_MODE does not send a real SMS (no network call)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network must not be called in TEST_MODE');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const a = await inbound('+15550000001', 'hello'); // Seller 1
    const res = await processSellerReply(buildReply(sellers[0].telegramUserId, a.notificationMessageId, 'reply text'));

    expect(res.outcome).toBe('test_sent');
    expect(fetchSpy).not.toHaveBeenCalled();
    const outbound = await prisma.message.findFirst({ where: { direction: 'outbound' } });
    expect(outbound?.status).toBe('test_sent');
  });

  it('Test 10: a RingCentral send failure is saved as failed and the seller is notified', async () => {
    // Force the real send path.
    config.allowRealSms = true;

    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/sms')) {
        // 400 = permanent error, no retry, must be saved as failed.
        return new Response(JSON.stringify({ errorCode: 'InvalidParameter', message: 'bad request' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = await inbound('+15550000001', 'hello'); // Seller 1
    const res = await processSellerReply(buildReply(sellers[0].telegramUserId, a.notificationMessageId, 'reply text'));

    expect(res.outcome).toBe('failed');
    const outbound = await prisma.message.findFirst({ where: { direction: 'outbound' } });
    expect(outbound?.status).toBe('failed');
    expect(outbound?.failureReason).toBeTruthy();

    // Seller was notified of the failure.
    const confirmation = telegramOutbox[telegramOutbox.length - 1];
    expect(confirmation.chatId).toBe(sellers[0].telegramUserId);
    expect(confirmation.text).toContain('FAILED');
  });

  it('sendSms refuses when the target number does not match the contact on file', async () => {
    // Guards run BEFORE the TEST_MODE short-circuit, so no network is needed.
    const fetchSpy = vi.fn(async () => {
      throw new Error('must not send');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const a = await inbound('+15550000001', 'hi'); // Client A -> Seller 1
    const res = await sendSms({
      from: config.ringcentral.fromNumber,
      to: '+15550009991', // NOT Client A's number
      text: 'x',
      conversationId: a.result.conversationId!,
      sellerId: sellers[0].id,
    });

    expect(res.ok).toBe(false);
    expect(res.failureReason).toContain('recipient_mismatch');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sendSms refuses when the seller does not own the conversation', async () => {
    const a = await inbound('+15550000001', 'hi'); // owned by Seller 1
    const res = await sendSms({
      from: config.ringcentral.fromNumber,
      to: '+15550000001',
      text: 'x',
      conversationId: a.result.conversationId!,
      sellerId: sellers[1].id, // Seller 2 does not own it
    });
    expect(res.ok).toBe(false);
    expect(res.failureReason).toContain('ownership');
  });
});
