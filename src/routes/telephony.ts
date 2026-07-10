import { Router } from 'express';
import { prisma } from '../db';
import { logger } from '../logger';
import { getOrAssignSellerForCall } from '../services/calls';
import { forwardCall } from '../services/call-control';
import { rcConfigForLine } from '../services/ringcentral';
import { sendTelegramMessage } from '../services/telegram';
import { getSellerLineTopic } from '../services/routing';

export const telephonyRouter = Router();

/**
 * Per-session routing state. A call that enters through the Auto-Receptionist
 * produces SEVERAL legs (parties) across events: the AA leg (not controllable —
 * forwarding it returns TAS-106) and then the target-extension leg. We claim
 * the session on the first ringing party that targets one of OUR lines, then
 * keep attempting the forward on each new ringing leg until one succeeds.
 */
interface SessionState {
  lineId: string;
  lineName: string;
  linePhone: string;
  clientPhone: string;
  seller: { id: string; name: string; telegramUserId: string | null; phoneE164: string | null };
  forwarded: boolean;
  notified: boolean;
  tried: Set<string>;
  ts: number;
}
const sessions = new Map<string, SessionState>();

function gcSessions(): void {
  if (sessions.size <= 500) return;
  const cutoff = Date.now() - 3_600_000;
  for (const [k, s] of sessions) if (s.ts < cutoff) sessions.delete(k);
}

/**
 * RingCentral Telephony Session webhook.
 * 1. Subscription handshake: echo the `Validation-Token` header.
 * 2. Inbound call to one of OUR lines: resolve the sticky seller once, notify
 *    Telegram once, and forward the ringing leg to the seller's phone —
 *    retrying on each new leg (AA leg -> extension leg) until it succeeds.
 * Calls to any other company number are ignored entirely.
 */
telephonyRouter.post('/', async (req, res) => {
  const validation = req.header('Validation-Token');
  if (validation) {
    res.set('Validation-Token', validation);
    res.status(200).end();
    return;
  }

  // Ack immediately — RingCentral expects a fast 200, then we work async.
  res.status(200).end();

  try {
    const body = (req.body?.body ?? {}) as any;
    const sessionId: string | undefined = body.telephonySessionId;
    const parties: any[] = body.parties ?? [];
    if (!sessionId || parties.length === 0) return;

    const ringing = parties.filter(
      (p) => p?.direction === 'Inbound' && (p?.status?.code === 'Setup' || p?.status?.code === 'Proceeding'),
    );

    let state = sessions.get(sessionId);

    // Claim the session if a ringing party targets one of OUR lines. The
    // account-wide subscription sees EVERY company call; getOrAssignSellerForCall
    // only matches explicitly configured lines and ignores the rest.
    if (!state) {
      for (const p of ringing) {
        const from: string | undefined = p.from?.phoneNumber;
        const to: string | undefined = p.to?.phoneNumber;
        if (!from || !to) continue;
        const owner = await getOrAssignSellerForCall(from, to);
        if (!owner) continue;

        state = {
          lineId: owner.line.id,
          lineName: owner.line.name,
          linePhone: owner.line.phoneE164,
          clientPhone: from,
          seller: owner.seller,
          forwarded: false,
          notified: false,
          tried: new Set(),
          ts: Date.now(),
        };
        sessions.set(sessionId, state);
        gcSessions();
        logger.info('live_call_routed', { from, to, sellerId: owner.seller.id, sellerName: owner.seller.name, isNew: owner.isNewContact });

        if (!owner.seller.phoneE164) {
          logger.warn('live_call_no_forward_number', { sellerId: owner.seller.id, sellerName: owner.seller.name });
        }
        if (owner.seller.telegramUserId) {
          const topicId = await getSellerLineTopic(owner.seller.id, owner.line.id);
          const note = owner.seller.phoneE164
            ? `📞 Apel de la ${from} — ți-l transfer acum pe ${owner.seller.phoneE164}.`
            : `📞 Apel de la ${from} pe linia ${owner.line.name} — clientul e al tău (nu ai număr de transfer setat).`;
          await sendTelegramMessage(owner.seller.telegramUserId, note, { messageThreadId: topicId ?? undefined });
          state.notified = true;
        }
        break;
      }
      if (!state) return; // not one of our lines — someone else's call, ignore
    }

    // Diagnostic trail for OUR sessions only: how each leg looks per event.
    logger.info('telephony_session_event', {
      sessionId,
      parties: parties.map((p) => ({ id: p.id, dir: p.direction, status: p.status?.code, ext: p.extensionId, to: p.to?.phoneNumber, rcc: p.status?.rcc })),
    });

    // Forward: try every ringing leg we haven't tried yet, until one sticks.
    if (!state.forwarded && state.seller.phoneE164) {
      const line = await prisma.line.findUnique({ where: { id: state.lineId } });
      const rc = rcConfigForLine(line);
      for (const p of ringing) {
        const pid: string | undefined = p.id;
        if (!pid || state.tried.has(pid)) continue;
        state.tried.add(pid);
        const result = await forwardCall(rc, sessionId, pid, state.seller.phoneE164);
        if (result.ok) {
          state.forwarded = true;
          break;
        }
      }
    }
  } catch (e) {
    logger.error('telephony_webhook_error', { error: e instanceof Error ? e.message : String(e) });
  }
});
