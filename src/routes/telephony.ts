import { Router } from 'express';
import { handleTelephonyBody } from '../services/telephony-handler';

export const telephonyRouter = Router();

/**
 * RingCentral Telephony Session WEBHOOK (fallback transport — WebSocket is the
 * primary, tunnel-free one). 1) echoes the Validation-Token handshake; 2) hands
 * the event body to the shared handler.
 */
telephonyRouter.post('/', async (req, res) => {
  const validation = req.header('Validation-Token');
  if (validation) {
    res.set('Validation-Token', validation);
    res.status(200).end();
    return;
  }
  res.status(200).end(); // ack fast, then work async
  const body = (req.body?.body ?? {}) as any;
  await handleTelephonyBody(body);
});
