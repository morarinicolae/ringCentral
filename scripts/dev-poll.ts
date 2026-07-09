import 'dotenv/config';
import { config } from '../src/config';
import { getAccessToken } from '../src/services/ringcentral';

/**
 * DEV-ONLY bridge for running locally without a public URL.
 * Polls Telegram getUpdates + RingCentral A2P inbound SMS and forwards them to
 * the local webhooks, so the full flow (inbound SMS -> Telegram -> reply -> SMS)
 * works on localhost. Run in a second terminal alongside `npm run dev`:
 *
 *   npm run dev:poll
 */
const base = `http://localhost:${config.port}`;
let tgOffset = 0;
const seenSms = new Set<string>();

async function pollTelegram() {
  if (!config.telegram.botToken) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/getUpdates?timeout=0&offset=${tgOffset}`,
    );
    const j = (await res.json()) as any;
    for (const u of j.result || []) {
      tgOffset = u.update_id + 1;
      await fetch(`${base}/webhooks/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(u),
      });
      const txt = u.message?.text;
      if (txt) console.log(`[dev-poll] telegram reply from ${u.message?.from?.id}: "${txt.slice(0, 30)}"`);
    }
  } catch {
    /* transient — ignore */
  }
}

async function pollA2p() {
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
      await fetch(`${base}/webhooks/ringcentral/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      console.log(`[dev-poll] inbound SMS ${m.from} -> "${(detail.text || '').slice(0, 30)}"`);
    }
  } catch {
    /* transient — ignore */
  }
}

async function main() {
  // Ensure no Telegram webhook is set (getUpdates and webhooks are mutually exclusive).
  if (config.telegram.botToken) {
    await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/deleteWebhook`).catch(() => {});
    // Skip old backlog so we only forward NEW replies.
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getUpdates`);
      const j = (await res.json()) as any;
      const last = (j.result || []).slice(-1)[0];
      if (last) tgOffset = last.update_id + 1;
    } catch {
      /* ignore */
    }
  }
  console.log('[dev-poll] bridging Telegram replies + A2P inbound SMS -> localhost webhooks. Ctrl+C to stop.');
  setInterval(pollTelegram, 3000);
  setInterval(pollA2p, 8000);
}

main();
