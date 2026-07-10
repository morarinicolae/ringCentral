import { config } from './config';
import { prisma } from './db';
import { getAccessTokenFor, rcConfigForLine, rcAccountKey, RcConfig } from './services/ringcentral';
import { processInboundCall } from './services/calls';
import { ensureTelephonySubscription } from './services/call-control';
import { syncQueueRuleForSeller } from './services/queue-rules';
import { logger } from './logger';

/**
 * Group all active lines by their RingCentral ACCOUNT (each number can be a
 * separate account). Returns one entry per distinct account with the set of the
 * company numbers it owns, so we poll each account once and route each record to
 * the matching line by its `to` number.
 */
async function activeAccounts(): Promise<Array<{ rc: RcConfig; numbers: Set<string> }>> {
  const lines = await prisma.line.findMany({ where: { isActive: true } });
  const map = new Map<string, { rc: RcConfig; numbers: Set<string> }>();
  for (const l of lines) {
    const rc = rcConfigForLine(l);
    const key = rcAccountKey(rc);
    let g = map.get(key);
    if (!g) {
      g = { rc, numbers: new Set() };
      map.set(key, g);
    }
    g.numbers.add(l.phoneE164);
  }
  // Legacy single-account fallback: if there are no lines yet, still poll the
  // global env account filtered to its configured number.
  if (map.size === 0 && config.ringcentral.fromNumber) {
    map.set('global', { rc: rcConfigForLine(null), numbers: new Set([config.ringcentral.fromNumber]) });
  }
  return [...map.values()];
}

/**
 * Polling bridge that works WITHOUT a public URL: it pulls Telegram replies and
 * RingCentral A2P inbound SMS and feeds them into the app's own webhooks.
 *
 * Used two ways:
 *  - In-process on the server when POLL_MODE=true (single-process VPS deploy
 *    behind an existing reverse proxy / on a port-locked host like a mail server).
 *  - Standalone via `npm run dev:poll` for local development.
 */
const base = () => `http://localhost:${config.port}`;
let tgOffset = 0;
const seenSms = new Set<string>();
const seenCalls = new Set<string>();

export async function pollTelegramOnce(): Promise<void> {
  if (!config.telegram.botToken) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/getUpdates?timeout=0&offset=${tgOffset}`,
    );
    const j = (await res.json()) as any;
    for (const u of j.result || []) {
      tgOffset = u.update_id + 1;
      await fetch(`${base()}/webhooks/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(u),
      });
    }
  } catch (e) {
    logPollError('telegram_getupdates', e);
  }
}

// Surface poll failures (auth/permission/network) without spamming: at most one
// line per source per 60s. Silent catches were hiding 401/403 from RingCentral.
const lastErrLog = new Map<string, number>();
function logPollError(where: string, detail: unknown, serverUrl?: string): void {
  const now = Date.now();
  if (now - (lastErrLog.get(where) ?? 0) < 60_000) return;
  lastErrLog.set(where, now);
  logger.warn('poll_error', { where, server: serverUrl, detail: detail instanceof Error ? detail.message : String(detail) });
}

async function postInboundSms(payload: unknown): Promise<void> {
  await fetch(`${base()}/webhooks/ringcentral/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function pollInboundSmsOnce(): Promise<void> {
  const accounts = await activeAccounts();
  const dateFrom = new Date(Date.now() - 5 * 60_000).toISOString();
  for (const { rc, numbers } of accounts) {
    try {
      const token = await getAccessTokenFor(rc);
      const auth = { Authorization: `Bearer ${token}` };
      if (rc.useA2p) {
        // A2P High Volume inbound. The list omits the text, so fetch each by id.
        const r = await fetch(
          `${rc.serverUrl}/restapi/v1.0/account/~/a2p-sms/messages?direction=Inbound&dateFrom=${encodeURIComponent(dateFrom)}&perPage=50`,
          { headers: auth },
        );
        const j = (await r.json()) as any;
        if (!r.ok) {
          logPollError('a2p_inbound', `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`, rc.serverUrl);
          continue;
        }
        for (const m of j.records || []) {
          if (!(m.to || []).some((t: string) => numbers.has(t))) continue;
          if (seenSms.has(m.id)) continue;
          seenSms.add(m.id);
          const dr = await fetch(`${rc.serverUrl}/restapi/v1.0/account/~/a2p-sms/messages/${m.id}`, { headers: auth });
          const detail = (await dr.json()) as any;
          await postInboundSms({
            body: {
              id: `a2p-${m.id}`,
              from: m.from,
              to: (m.to || []).map((p: string) => ({ phoneNumber: p })),
              subject: detail.text ?? '',
              direction: 'Inbound',
              type: 'SMS',
              creationTime: m.creationTime,
            },
          });
          logger.info('poll_inbound_sms', { from: m.from, text: (detail.text || '').slice(0, 40) });
        }
      }
      // Classic message store: the only source on non-A2P accounts; on A2P
      // accounts it is polled ONLY for replies to the SMS override number
      // (line-number traffic arrives via the A2P feed — avoids duplicates).
      if (!rc.useA2p || config.ringcentral.smsFrom) {
        const acceptTo = (t: string) =>
          rc.useA2p ? Boolean(config.ringcentral.smsFrom) && t === config.ringcentral.smsFrom : numbers.has(t);
        const r = await fetch(
          `${rc.serverUrl}/restapi/v1.0/account/~/extension/~/message-store?direction=Inbound&messageType=SMS&dateFrom=${encodeURIComponent(dateFrom)}&perPage=50`,
          { headers: auth },
        );
        const j = (await r.json()) as any;
        if (!r.ok) {
          logPollError('message_store_inbound', `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`, rc.serverUrl);
          continue;
        }
        for (const m of j.records || []) {
          const tos = (m.to || []).map((x: any) => x.phoneNumber);
          if (!tos.some((t: string) => acceptTo(t))) continue;
          const id = `ms-${m.id}`;
          if (seenSms.has(id)) continue;
          seenSms.add(id);
          await postInboundSms({
            body: {
              id,
              from: m.from?.phoneNumber,
              to: (m.to || []).map((x: any) => ({ phoneNumber: x.phoneNumber })),
              subject: m.subject ?? '',
              direction: 'Inbound',
              type: 'SMS',
              creationTime: m.creationTime,
            },
          });
          logger.info('poll_inbound_sms', { from: m.from?.phoneNumber, text: (m.subject || '').slice(0, 40) });
        }
      }
    } catch (e) {
      logPollError('inbound_sms', e, rc.serverUrl);
    }
  }
}

/** @deprecated kept for compatibility; delegates to pollInboundSmsOnce. */
export async function pollA2pOnce(): Promise<void> {
  return pollInboundSmsOnce();
}

/**
 * Poll the RingCentral call log for recent INBOUND calls and record any that
 * were placed to one of our configured line numbers (answered OR missed).
 */
/**
 * Queue mode: figure out WHICH SELLER answered this call from the detailed
 * call-log legs (the accepted leg's extension, ignoring the queue's own leg),
 * matched against sellers' ringcentralExtensionId.
 */
async function answeredSellerFromLegs(record: any): Promise<string | null> {
  const legs: any[] = record?.legs ?? [];
  if (!legs.length) return null;
  const queueExtId = config.ringcentral.queueExtensionId;
  const accepted = legs.filter((l) => {
    const res = (l?.result ?? '').toLowerCase();
    const extId = l?.extension?.id != null ? String(l.extension.id) : null;
    return (res.includes('accept') || res.includes('connected')) && extId && extId !== queueExtId;
  });
  if (!accepted.length) return null;
  const sellers = await prisma.seller.findMany({ where: { isActive: true, ringcentralExtensionId: { not: null } } });
  for (const leg of accepted) {
    const extId = String(leg.extension.id);
    const seller = sellers.find((s) => s.ringcentralExtensionId === extId);
    if (seller) return seller.id;
  }
  return null;
}

export async function pollCallsOnce(): Promise<void> {
  const accounts = await activeAccounts();
  const dateFrom = new Date(Date.now() - 10 * 60_000).toISOString();
  for (const { rc, numbers } of accounts) {
    try {
      const token = await getAccessTokenFor(rc);
      const r = await fetch(
        `${rc.serverUrl}/restapi/v1.0/account/~/call-log?direction=Inbound&view=Detailed&dateFrom=${encodeURIComponent(dateFrom)}&perPage=100`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = (await r.json()) as any;
      if (!r.ok) {
        logPollError('call_log', `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`, rc.serverUrl);
        continue;
      }
      for (const c of j.records || []) {
        const to = c.to?.phoneNumber;
        const from = c.from?.phoneNumber;
        if (!to || !from || !numbers.has(to)) continue;
        if (seenCalls.has(c.id)) continue;
        seenCalls.add(c.id);

        // Queue mode: ownership follows whoever ANSWERED (from the call legs).
        const answeredSellerId = config.callAssignMode === 'answered' ? await answeredSellerFromLegs(c) : null;

        const res = await processInboundCall(
          {
            from,
            to,
            ringcentralCallId: c.id,
            result: c.result,
            durationSec: typeof c.duration === 'number' ? c.duration : undefined,
            startedAt: c.startTime,
          },
          { answeredSellerId },
        );
        if (res.status === 'processed') {
          logger.info('poll_inbound_call', { from, to, result: res.result, sellerId: res.sellerId, answeredSellerId });
          // Native sticky: refresh the queue rule so this caller's future calls
          // ring their seller directly (skips queue rotation).
          if (config.callAssignMode === 'answered' && res.sellerId) {
            syncQueueRuleForSeller(res.sellerId).catch(() => {});
          }
        }
      }
    } catch (e) {
      logPollError('call_log', e, rc.serverUrl);
    }
  }
}

/** Start the polling loops. Clears any Telegram webhook and skips the backlog first. */
export async function startPolling(): Promise<void> {
  if (config.telegram.botToken) {
    await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/deleteWebhook`).catch(() => {});
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getUpdates`);
      const j = (await res.json()) as any;
      const last = (j.result || []).slice(-1)[0];
      if (last) tgOffset = last.update_id + 1;
    } catch {
      /* ignore */
    }
  }
  // Live call transfer: keep a telephony webhook subscription alive when a
  // public base URL is configured (the tunnel). Self-heals every 6h.
  const telephonyWebhook = config.appBaseUrl ? `${config.appBaseUrl.replace(/\/$/, '')}/webhooks/ringcentral/telephony` : '';
  if (/^https:\/\//.test(telephonyWebhook)) {
    ensureTelephonySubscription(telephonyWebhook)
      .then((r) => logger.info('telephony_subscription_ensured', { ok: r.ok, created: r.created, id: r.id }))
      .catch(() => {});
    setInterval(() => {
      ensureTelephonySubscription(telephonyWebhook).catch(() => {});
    }, 6 * 3600 * 1000);
  }

  logger.info('polling_started', { telegram: Boolean(config.telegram.botToken), sms: true, calls: true, liveTransfer: Boolean(telephonyWebhook) });
  setInterval(pollTelegramOnce, 3000);
  setInterval(pollInboundSmsOnce, 8000);
  setInterval(pollCallsOnce, 15000);
}
