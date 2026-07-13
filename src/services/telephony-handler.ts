import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { getOrAssignSellerForCall } from './calls';
import { forwardCall } from './call-control';
import { rcConfigForLine, getOwnExtensionId } from './ringcentral';
import { sendTelegramMessage } from './telegram';
import { getSellerLineTopic } from './routing';

/**
 * Shared inbound-call logic for BOTH transports (WebHook route + WebSocket
 * subscription). A call that enters through the Auto-Receptionist produces
 * several legs across events: the AA leg (not controllable — forwarding returns
 * TAS-106) then the dispatcher-extension leg. We claim the session on the first
 * ringing party that targets one of OUR lines (or the dispatcher extension),
 * then retry the forward on each new ringing leg until one sticks.
 */
interface SessionState {
  lineId: string;
  seller: { id: string; name: string; telegramUserId: string | null; phoneE164: string | null };
  forwarded: boolean;
  tried: Set<string>;
  ts: number;
}
const sessions = new Map<string, SessionState>();

function gcSessions(): void {
  if (sessions.size <= 500) return;
  const cutoff = Date.now() - 3_600_000;
  for (const [k, s] of sessions) if (s.ts < cutoff) sessions.delete(k);
}

/** Process one telephony-session event body (the `.body` of the notification). */
export async function handleTelephonyBody(body: any): Promise<void> {
  try {
    const sessionId: string | undefined = body?.telephonySessionId;
    const parties: any[] = body?.parties ?? [];
    if (!sessionId || parties.length === 0) return;

    const ringing = parties.filter(
      (p) => p?.direction === 'Inbound' && (p?.status?.code === 'Setup' || p?.status?.code === 'Proceeding'),
    );

    let state = sessions.get(sessionId);

    if (!state) {
      const dispatcherExtId = await getOwnExtensionId();
      for (const p of ringing) {
        const from: string | undefined = p.from?.phoneNumber;
        const to: string | undefined = p.to?.phoneNumber;
        if (!from) continue;
        let owner = to ? await getOrAssignSellerForCall(from, to) : null;
        if (!owner && dispatcherExtId && String(p.extensionId ?? '') === dispatcherExtId) {
          owner = await getOrAssignSellerForCall(from, config.ringcentral.fromNumber);
        }
        if (!owner) continue;

        state = { lineId: owner.line.id, seller: owner.seller, forwarded: false, tried: new Set(), ts: Date.now() };
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
        }
        break;
      }
      if (!state) return; // not one of our lines — ignore
    }

    logger.info('telephony_session_event', {
      sessionId,
      parties: parties.map((p) => ({ id: p.id, dir: p.direction, status: p.status?.code, ext: p.extensionId, to: p.to?.phoneNumber })),
    });

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
    logger.error('telephony_handler_error', { error: e instanceof Error ? e.message : String(e) });
  }
}
