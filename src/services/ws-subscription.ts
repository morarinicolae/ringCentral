import WebSocket from 'ws';
import { config } from '../config';
import { logger } from '../logger';
import { getAccessTokenFor, globalRcConfig } from './ringcentral';
import { handleTelephonyBody } from './telephony-handler';

/**
 * TUNNEL-FREE transport: RingCentral WebSocket Gateway (WSG).
 *
 * The app opens an OUTBOUND WebSocket to wss://ws.ringcentral.com and creates a
 * telephony-sessions subscription over it — no public webhook URL, no tunnel,
 * no open port on the Zimbra VPS. Events arrive as ServerNotification frames and
 * are handed to the same handler the webhook uses.
 *
 * Wire protocol (WSG): every frame is a JSON array [meta, body].
 *   server -> ConnectionDetails            (on connect)
 *   client -> ClientRequest + body         (create subscription)
 *   server -> ClientRequestSuccess + sub   (created)
 *   server -> ServerNotification + event   (an inbound call)
 *
 * Self-healing: heartbeats keep the socket alive; on close it reconnects with
 * backoff and recreates the subscription; the subscription is refreshed before
 * it expires.
 */

const EVENT_FILTER = '/restapi/v1.0/account/~/telephony/sessions?direction=Inbound';

let ws: WebSocket | null = null;
let stopped = false;
let reconnectDelay = 1000;
let msgCounter = 0;
let subscriptionId: string | null = null;
let hbTimer: NodeJS.Timeout | null = null;
let renewTimer: NodeJS.Timeout | null = null;

const wsUrl = () => (process.env.RINGCENTRAL_WS_URL || 'wss://ws.ringcentral.com/ws').trim();
const newMsgId = () => `router-${Date.now()}-${++msgCounter}`;

function clearTimers(): void {
  if (hbTimer) clearInterval(hbTimer);
  if (renewTimer) clearTimeout(renewTimer);
  hbTimer = renewTimer = null;
}

function sendFrame(meta: object, body?: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(body !== undefined ? [meta, body] : [meta]));
  }
}

function createSubscription(): void {
  sendFrame(
    { type: 'ClientRequest', messageId: newMsgId(), method: 'POST', path: '/restapi/v1.0/subscription' },
    { eventFilters: [EVENT_FILTER], deliveryMode: { transportType: 'WebSocket' } },
  );
}

function scheduleRenew(expiresInSec?: number): void {
  if (renewTimer) clearTimeout(renewTimer);
  const ms = Math.max(60_000, ((expiresInSec ?? 600) - 60) * 1000);
  renewTimer = setTimeout(() => {
    // Recreate fresh (drops the previous one) — simplest reliable refresh.
    if (subscriptionId) {
      sendFrame({ type: 'ClientRequest', messageId: newMsgId(), method: 'DELETE', path: `/restapi/v1.0/subscription/${subscriptionId}` });
      subscriptionId = null;
    }
    createSubscription();
  }, ms);
}

function onMessage(raw: string): void {
  let frame: any;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  const meta = Array.isArray(frame) ? frame[0] : frame;
  const body = Array.isArray(frame) ? frame[1] : undefined;
  switch (meta?.type) {
    case 'ConnectionDetails':
      logger.info('ws_connected', { recoveryState: meta.recoveryState });
      createSubscription();
      break;
    case 'ClientRequestSuccess':
      if (body?.eventFilters) {
        subscriptionId = body.id ?? subscriptionId;
        logger.info('ws_subscribed', { id: body.id, expiresIn: body.expiresIn });
        scheduleRenew(body.expiresIn);
      }
      break;
    case 'ClientRequestError':
      logger.error('ws_request_error', { status: meta.status, body: JSON.stringify(body).slice(0, 300) });
      break;
    case 'ServerNotification':
      if (typeof body?.event === 'string' && body.event.includes('telephony/sessions') && body.body) {
        handleTelephonyBody(body.body).catch(() => {});
      }
      break;
    default:
      break;
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  clearTimers();
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  setTimeout(() => connect().catch((e) => logger.error('ws_connect_error', { error: e instanceof Error ? e.message : String(e) })), delay);
}

async function connect(): Promise<void> {
  if (stopped) return;
  const token = await getAccessTokenFor(globalRcConfig());
  const url = `${wsUrl()}?access_token=${encodeURIComponent(token)}`;
  logger.info('ws_connecting', { url: wsUrl() });
  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectDelay = 1000;
    // App-level heartbeat keeps the gateway session alive.
    clearTimers();
    hbTimer = setInterval(() => sendFrame({ type: 'Heartbeat', messageId: newMsgId() }), 5 * 60_000);
  });
  ws.on('message', (data: WebSocket.RawData) => onMessage(data.toString()));
  ws.on('close', (code: number, reason: Buffer) => {
    logger.warn('ws_close', { code, reason: reason?.toString()?.slice(0, 120) });
    clearTimers();
    scheduleReconnect();
  });
  ws.on('error', (err: Error) => {
    logger.error('ws_error', { error: err.message });
    // 'close' fires after 'error' and drives the reconnect.
  });
}

/** Start the WebSocket transport (call once at boot when WS mode is enabled). */
export async function startWebSocketTransport(): Promise<void> {
  stopped = false;
  await connect().catch((e) => {
    logger.error('ws_connect_error', { error: e instanceof Error ? e.message : String(e) });
    scheduleReconnect();
  });
}

export function stopWebSocketTransport(): void {
  stopped = true;
  clearTimers();
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
}
