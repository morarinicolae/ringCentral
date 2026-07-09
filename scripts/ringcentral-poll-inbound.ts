import 'dotenv/config';
import { config } from '../src/config';
import { getAccessToken } from '../src/services/ringcentral';

/**
 * Poll RingCentral Message Store for recent INBOUND SMS and forward each one to
 * the local /webhooks/ringcentral/sms endpoint (the real inbound path, with
 * idempotency by ringcentral message id).
 *
 * This is an interim alternative to a public webhook subscription — useful when
 * the app has no public URL yet. Usage:
 *   npm run rc:poll-inbound -- [minutesBack]   (default 30)
 */
async function main() {
  const minutesBack = Number(process.argv[2]) || 30;
  const dateFrom = new Date(Date.now() - minutesBack * 60_000).toISOString();
  const token = await getAccessToken();

  const url =
    `${config.ringcentral.serverUrl}/restapi/v1.0/account/~/extension/~/message-store` +
    `?messageType=SMS&direction=Inbound&dateFrom=${encodeURIComponent(dateFrom)}&perPage=25`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  const msgs = (j.records || []) as any[];
  console.log(`Found ${msgs.length} inbound SMS since ${dateFrom}`);

  for (const m of msgs.reverse()) {
    // Build the RingCentral instant-SMS event shape our webhook understands.
    const payload = {
      body: {
        id: m.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
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
    console.log(`  ${m.from?.phoneNumber} -> "${(m.subject || '').slice(0, 45)}" | webhook: ${JSON.stringify(wj)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
