import { Router } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { extractInboundFromRingCentral, ingestInbounds } from '../services/ingest';
import { parseTelegramUpdate } from '../services/telegram';
import { processSellerReply } from '../services/reply';

export const webhooksRouter = Router();

/**
 * POST /webhooks/ringcentral/sms
 * Receives incoming RingCentral SMS webhook events.
 *
 * Handles RingCentral's subscription validation handshake: on the initial
 * verification request RC sends a `Validation-Token` header which we must echo
 * back verbatim. We always ack 200 quickly; idempotency + processing happen
 * inside ingestInbounds (raw event stored first, then processed).
 */
webhooksRouter.post('/ringcentral/sms', async (req, res) => {
  const validationToken = req.header('validation-token');
  if (validationToken) {
    res.setHeader('Validation-Token', validationToken);
  }

  try {
    const inbounds = extractInboundFromRingCentral(req.body);
    const summary = await ingestInbounds('ringcentral', inbounds, req.body);
    res.status(200).json({ ok: true, status: summary.status, webhookEventId: summary.webhookEventId });
  } catch (err) {
    // Never lose the raw event: ingestInbounds already stored it. If we got
    // here it's an extraction-time error; log and still 200 so RC doesn't storm.
    logger.error('ringcentral_webhook_error', { error: err instanceof Error ? err.message : String(err) });
    res.status(200).json({ ok: false, error: 'processing_error' });
  }
});

/**
 * POST /webhooks/telegram
 * Receives Telegram bot updates (seller replies). Verifies the optional secret
 * token, dedupes at the webhook layer via update_id, then processes the reply.
 */
webhooksRouter.post('/telegram', async (req, res) => {
  if (config.telegram.webhookSecret) {
    const secret = req.header('x-telegram-bot-api-secret-token');
    if (secret !== config.telegram.webhookSecret) {
      res.status(401).json({ ok: false, error: 'bad_secret' });
      return;
    }
  }

  const update = req.body;
  const parsed = parseTelegramUpdate(update);
  if (!parsed) {
    // Not a message we handle (edited message, callback, etc.). Ack.
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  // Webhook-level idempotency using Telegram's update_id.
  const { prisma } = await import('../db');
  const eventHash = `telegram:update:${parsed.updateId ?? `${parsed.chatId}:${parsed.messageId}`}`;
  try {
    await prisma.webhookEvent.create({
      data: {
        provider: 'telegram',
        externalEventId: parsed.updateId != null ? String(parsed.updateId) : null,
        eventHash,
        status: 'received',
        rawPayloadJson: JSON.stringify(update),
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      logger.info('duplicate_webhook_ignored', { provider: 'telegram', eventHash });
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    throw err;
  }

  try {
    const result = await processSellerReply(parsed);
    await prisma.webhookEvent.updateMany({ where: { eventHash }, data: { status: 'processed', processedAt: new Date() } });
    res.status(200).json({ ok: true, outcome: result.outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('telegram_webhook_error', { error: message });
    await prisma.webhookEvent.updateMany({ where: { eventHash }, data: { status: 'failed', errorMessage: message, processedAt: new Date() } });
    res.status(200).json({ ok: false, error: 'processing_error' });
  }
});
