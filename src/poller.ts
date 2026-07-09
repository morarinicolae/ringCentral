import { config } from './config';
import { prisma } from './db';
import { getAccessToken } from './services/ringcentral';
import { processInboundCall } from './services/calls';
import { logger } from './logger';

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
  } catch {
    /* transient — ignore */
  }
}

export async function pollA2pOnce(): Promise<void> {
  if (!config.ringcentral.useA2p || !config.ringcentral.fromNumber) return;
  try {
    const token = await getAccessToken();
    const dateFrom = new Date(Date.now() - 5 * 60_000).toISOString();
    const r = await fetch(
      `${config.ringcentral.serverUrl}/restapi/v1.0/account/~/a2p-sms/messages?direction=Inbound&dateFrom=${encodeURIComponent(dateFrom)}&perPage=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const j = (await r.json()) as any;
    for (const m of j.records || []) {
      if (!(m.to || []).includes(config.ringcentral.fromNumber)) continue;
      if (seenSms.has(m.id)) continue;
      seenSms.add(m.id);
      const dr = await fetch(`${config.ringcentral.serverUrl}/restapi/v1.0/account/~/a2p-sms/messages/${m.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const detail = (await dr.json()) as any;
      const payload = {
        body: {
          id: `a2p-${m.id}`,
          from: m.from,
          to: (m.to || []).map((p: string) => ({ phoneNumber: p })),
          subject: detail.text ?? '',
          direction: 'Inbound',
          type: 'SMS',
          creationTime: m.creationTime,
        },
      };
      await fetch(`${base()}/webhooks/ringcentral/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      logger.info('poll_inbound_sms', { from: m.from, text: (detail.text || '').slice(0, 40) });
    }
  } catch {
    /* transient — ignore */
  }
}

/**
 * Poll the RingCentral call log for recent INBOUND calls and record any that
 * were placed to one of our configured line numbers (answered OR missed).
 */
export async function pollCallsOnce(): Promise<void> {
  try {
    // Only process calls to numbers we actually manage as lines.
    const lines = await prisma.line.findMany({ where: { isActive: true }, select: { phoneE164: true } });
    const lineNumbers = new Set(lines.map((l) => l.phoneE164));
    if (lineNumbers.size === 0) return;

    const token = await getAccessToken();
    const dateFrom = new Date(Date.now() - 10 * 60_000).toISOString();
    const r = await fetch(
      `${config.ringcentral.serverUrl}/restapi/v1.0/account/~/call-log?direction=Inbound&view=Detailed&dateFrom=${encodeURIComponent(dateFrom)}&perPage=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const j = (await r.json()) as any;
    for (const c of j.records || []) {
      const to = c.to?.phoneNumber;
      const from = c.from?.phoneNumber;
      if (!to || !from || !lineNumbers.has(to)) continue;
      if (seenCalls.has(c.id)) continue;
      seenCalls.add(c.id);
      const res = await processInboundCall({
        from,
        to,
        ringcentralCallId: c.id,
        result: c.result,
        durationSec: typeof c.duration === 'number' ? c.duration : undefined,
        startedAt: c.startTime,
      });
      if (res.status === 'processed') {
        logger.info('poll_inbound_call', { from, to, result: res.result, sellerId: res.sellerId });
      }
    }
  } catch {
    /* transient — ignore */
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
  logger.info('polling_started', { telegram: Boolean(config.telegram.botToken), a2p: config.ringcentral.useA2p, calls: true });
  setInterval(pollTelegramOnce, 3000);
  setInterval(pollA2pOnce, 8000);
  setInterval(pollCallsOnce, 15000);
}
