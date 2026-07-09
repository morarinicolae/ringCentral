import 'dotenv/config';
import { ringCentralDiagnostic } from '../src/services/ringcentral-connect';

/**
 * Verify the RingCentral connection: authenticate and read the extension +
 * its SMS-capable numbers. Run: `npm run rc:test`.
 */
async function main() {
  const d = await ringCentralDiagnostic();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(d, null, 2));
  if (!d.configured) {
    console.log('\n➡  Set RINGCENTRAL_CLIENT_ID / CLIENT_SECRET / JWT (or USERNAME+PASSWORD) in .env.');
    process.exit(1);
  }
  if (!d.ok) {
    console.log('\n❌ Connection FAILED. Check credentials + RINGCENTRAL_SERVER_URL (sandbox vs prod).');
    process.exit(1);
  }
  console.log(`\n✅ Connected to RingCentral (${d.authMethod}).`);
  console.log(`   Extension: ${d.extension?.name ?? '?'} (#${d.extension?.extensionNumber ?? '?'})`);
  console.log(`   SMS-capable numbers: ${d.phoneNumbers?.length ? d.phoneNumbers.join(', ') : '(none found — you need an SMS-enabled number)'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
