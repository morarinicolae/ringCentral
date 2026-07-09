import 'dotenv/config';
import { config } from '../src/config';
import { getAccessToken } from '../src/services/ringcentral';

/**
 * Send ONE real SMS through RingCentral (diagnostic tool — always sends,
 * bypasses TEST_MODE on purpose). Usage:
 *   npm run rc:send -- <toNumberE164> "message text"
 * FROM is RINGCENTRAL_FROM_NUMBER from .env.
 */
async function main() {
  const [to, ...rest] = process.argv.slice(2);
  const text = rest.join(' ') || 'Test message from SMS Router';
  const from = config.ringcentral.fromNumber;
  if (!from) throw new Error('Set RINGCENTRAL_FROM_NUMBER in .env');
  if (!to) throw new Error('Usage: rc:send -- <toNumber> "text"');

  const token = await getAccessToken();
  const res = await fetch(`${config.ringcentral.serverUrl}/restapi/v1.0/account/~/extension/~/sms`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text }),
  });
  const json = (await res.json()) as any;
  console.log('HTTP', res.status);
  console.log(JSON.stringify(json, null, 2));
  if (!res.ok) process.exit(1);
  console.log(`\n✅ SMS submitted: ${from} -> ${to} | id=${json.id} | status=${json.messageStatus}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
