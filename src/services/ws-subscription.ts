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

const newMsgId = () => `router-${Date.now()}-${++msgCounter}`;

/**
 * RingCentral WebSocket handshake: POST /restapi/oauth/wstoken returns the WS
 * gateway URI + a short-lived ws access token. You connect to that URI with the
 * ws token (NOT the plain OAuth access token, and NOT a fixed URL — that 404s).
 * Requires the app `WebSocket` permission.
 */
async function getWsEndpoint(): Promise<{ url: string } | null> {
  const rc = globalRcConfig();
  const token = await getAccessTokenFor(rc);
  const r = await fetch(`${rc.serverUrl}/restapi/oauth/wstoken`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    logger.error('ws_token_failed', { status: r.status, body: JSON.stringify(j).slice(0, 200) });
    return null;
  }
  const uri: string = j.uri || (process.env.RINGCENTRAL_WS_URL ?? '');
  const wsToken: string = j.ws_access_token || j.wsAccessToken || '';
  if (!uri) return null;
  // Append the ws token unless the uri already carries it.
  const url = /access_token=/.test(uri) || !wsToken ? uri : `${uri}${uri.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(wsToken)}`;
  return { url };
}

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
  const type = meta?.type;

  // Subscription create/renew confirmation: the WSG returns the subscription
  // object (id + eventFilters), and labels the frame 'ClientRequest' (echoed),
  // NOT a distinct success type — so detect it by shape, not by label.
  if (body && typeof body === 'object' && body.id && Array.isArray(body.eventFilters)) {
    if (subscriptionId !== body.id) logger.info('ws_subscribed', { id: body.id, status: body.status, expiresIn: body.expiresIn });
    subscriptionId = body.id;
    scheduleRenew(body.expiresIn);
    return;
  }

  if (type === 'ConnectionDetails') {
    logger.info('ws_connected', {});
    createSubscription();
    return;
  }

  if (type === 'ServerNotification') {
    if (typeof body?.event === 'string' && body.event.includes('telephony/sessions') && body.body) {
      handleTelephonyBody(body.body).catch(() => {});
    }
    return;
  }

  // Any request that came back with an error status.
  if (meta?.status && Number(meta.status) >= 400) {
    logger.error('ws_request_error', { status: meta.status, body: JSON.stringify(body ?? {}).slice(0, 300) });
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
  const endpoint = await getWsEndpoint();
  if (!endpoint) {
    scheduleReconnect();
    return;
  }
  logger.info('ws_connecting', { url: endpoint.url.split('?')[0] });
  ws = new WebSocket(endpoint.url);

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
