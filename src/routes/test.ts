import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { ingestInbounds } from '../services/ingest';
import { processInboundCall } from '../services/calls';
import { InboundSms } from '../types';

export const testRouter = Router();

/**
 * POST /test/simulate-inbound-call
 * Body: { from, to?, result?, duration_sec?, ringcentral_call_id? }
 * Simulates a client calling a company number: line resolution -> round-robin
 * (new caller) / existing seller -> DB record (answered/missed) -> notification.
 */
const CallSchema = z.object({
  from: z.string().min(3),
  to: z.string().optional(),
  result: z.string().optional(),
  duration_sec: z.number().int().optional(),
  ringcentral_call_id: z.string().optional(),
});
testRouter.post('/simulate-inbound-call', async (req, res) => {
  const parsed = CallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const result = await processInboundCall({
    from: d.from,
    to: d.to ?? config.ringcentral.fromNumber,
    result: d.result ?? 'Accepted',
    durationSec: d.duration_sec,
    ringcentralCallId: d.ringcentral_call_id,
  });
  res.status(200).json({ ok: result.status !== 'rejected', result });
});

const SimulateSchema = z.object({
  from: z.string().min(3),
  to: z.string().optional(),
  text: z.string().min(1),
  // Optional: pass an explicit RC id or timestamp to control idempotency in tests.
  ringcentral_message_id: z.string().optional(),
  timestamp: z.string().optional(),
});

/**
 * POST /test/simulate-inbound-sms
 * Body: { from, to?, text, ringcentral_message_id?, timestamp? }
 *
 * Simulates the FULL inbound flow exactly like a real RingCentral webhook:
 * dedupe -> contact lookup/create -> round-robin for new clients -> save
 * message -> private Telegram notification to the assigned seller.
 *
 * Idempotency note: the event hash is derived from from/to/text/timestamp (or
 * an explicit ringcentral_message_id). Sending the SAME body twice is treated
 * as a duplicate webhook (used to prove no duplicate Telegram notification).
 */
testRouter.post('/simulate-inbound-sms', async (req, res) => {
  const parsed = SimulateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }

  const inbound: InboundSms = {
    from: parsed.data.from,
    to: parsed.data.to ?? config.ringcentral.fromNumber,
    text: parsed.data.text,
    ringcentralMessageId: parsed.data.ringcentral_message_id,
    timestamp: parsed.data.timestamp,
  };

  const summary = await ingestInbounds('ringcentral', [inbound], { simulated: true, ...inbound });
  const result = summary.results[0];

  res.status(200).json({
    ok: summary.status !== 'failed',
    webhook_status: summary.status,
    result: result
      ? {
          status: result.status,
          duplicate: result.duplicate ?? false,
          is_new_contact: result.isNewContact ?? false,
          line_id: result.lineId,
          line_name: result.lineName,
          assigned_seller_id: result.sellerId,
          assigned_seller_name: result.sellerName,
          conversation_id: result.conversationId,
          message_id: result.messageId,
          opt_out: result.optOut ?? false,
          seller_notified: result.notified ?? false,
        }
      : null,
  });
});
