import 'dotenv/config';
import { config } from '../src/config';
import { getAccessToken } from '../src/services/ringcentral';

/**
 * Poll RingCentral **A2P High Volume SMS** inbound messages (the channel used by
 * TCR/10DLC-registered numbers) and forward each one addressed to the company
 * number to the local /webhooks/ringcentral/sms endpoint.
 *
 * This is the correct inbound channel for A2P-registered accounts — regular
 * message-store does NOT carry these. Usage:
 *   npm run rc:poll-a2p -- [minutesBack]   (default 30)
 */
async function main() {
  const minutesBack = Number(process.argv[2]) || 30;
  const dateFrom = new Date(Date.now() - minutesBack * 60_000).toISOString();
  const company = config.ringcentral.fromNumber; // the number clients text
  const token = await getAccessToken();

  const listUrl =
    `${config.ringcentral.serverUrl}/restapi/v1.0/account/~/a2p-sms/messages` +
    `?direction=Inbound&dateFrom=${encodeURIComponent(dateFrom)}&perPage=100`;
  const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  const j = (await res.json()) as any;
  const all = (j.records || []) as any[];
  // Only messages addressed to OUR company number.
  const mine = all.filter((m) => (m.to || []).includes(company));
  console.log(`A2P inbound since ${dateFrom}: ${all.length} total, ${mine.length} to ${company}`);

  for (const m of mine.reverse()) {
    // Fetch the individual message to get its text (list view omits it).
    const dr = await fetch(`${config.ringcentral.serverUrl}/restapi/v1.0/account/~/a2p-sms/messages/${m.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const detail = (await dr.json()) as any;
    const text = detail.text ?? '';

    const payload = {
      body: {
        id: `a2p-${m.id}`,
        from: m.from, // string, parser handles it
        to: (m.to || []).map((p: string) => ({ phoneNumber: p })),
        subject: text,
        direction: 'Inbound',
        type: 'SMS',
        creationTime: m.creationTime,
      },
    };
    const wh = await fetch(`http://localhost:${config.port}/webhooks/ringcentral/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const wj = await wh.json().catch(() => ({}));
    console.log(`  ${m.from} -> "${text.slice(0, 45)}" | webhook: ${JSON.stringify(wj)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
