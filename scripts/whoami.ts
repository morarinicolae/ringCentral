/**
 * Diagnostic: which RingCentral extension is THIS app's account (the JWT user)?
 *
 * The router "claims" an inbound call in two cases: the call is TO a configured
 * line number, OR the ringing party's extension is the app's OWN extension
 * (resolved at runtime from the JWT — never hardcoded). So if you suspect the
 * app is interfering with a specific extension (e.g. 572), run this: if the
 * number printed here is NOT that extension, the app cannot be touching it.
 *
 *   npx tsx --env-file=.env scripts/whoami.ts
 */
import { getAccessTokenFor, globalRcConfig } from '../src/services/ringcentral';

async function main(): Promise<void> {
  const rc = globalRcConfig();
  const token = await getAccessTokenFor(rc);
  const r = await fetch(`${rc.serverUrl}/restapi/v1.0/account/~/extension/~`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log('HTTP', r.status, JSON.stringify(j).slice(0, 300));
    return;
  }
  console.log('This app authenticates as RingCentral extension:');
  console.log(
    JSON.stringify(
      {
        id: j.id,
        extensionNumber: j.extensionNumber,
        name: j.name ?? [j.contact?.firstName, j.contact?.lastName].filter(Boolean).join(' '),
        type: j.type,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
