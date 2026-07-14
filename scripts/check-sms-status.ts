/**
 * Diagnostic: check the REAL delivery status of an outbound SMS.
 *
 * "outbound_sms_sent" in our logs only means RingCentral ACCEPTED the message
 * (HTTP 2xx / Queued). Actual delivery happens async and can fail later
 * (unregistered 10DLC number -> carrier filtering). This script fetches the
 * message record from RingCentral and prints its messageStatus so we can tell
 * Queued / Sent / Delivered / DeliveryFailed / SendingFailed apart.
 *
 *   npx tsx --env-file=.env scripts/check-sms-status.ts <messageId>
 *
 * The messageId comes from the "outbound_sms_sent" log line
 * (field: ringcentralMessageId).
 */
import { getAccessTokenFor, globalRcConfig } from '../src/services/ringcentral';

async function fetchJson(url: string, token: string): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error('usage: npx tsx --env-file=.env scripts/check-sms-status.ts <messageId>');
    process.exit(1);
  }
  const rc = globalRcConfig();
  const token = await getAccessTokenFor(rc);

  // Classic /sms lands in the extension message-store; A2P sends live in a2p-sms.
  const candidates = [
    `${rc.serverUrl}/restapi/v1.0/account/~/extension/~/message-store/${id}`,
    `${rc.serverUrl}/restapi/v1.0/account/~/a2p-sms/messages/${id}`,
  ];

  for (const url of candidates) {
    const { status, body } = await fetchJson(url, token);
    if (status === 200) {
      const summary = {
        id: body.id,
        from: body.from?.phoneNumber ?? body.from,
        to: Array.isArray(body.to) ? body.to.map((t: any) => t.phoneNumber ?? t) : body.to,
        direction: body.direction,
        messageStatus: body.messageStatus, // Queued | Sent | Delivered | DeliveryFailed | SendingFailed
        creationTime: body.creationTime,
        // When present these explain a failed/queued state:
        statusDetail: body.messageStatusDetails ?? body.smsDeliveryTime ?? null,
        errorCode: body.errorCode ?? body.deliveryErrorCode ?? null,
      };
      console.log('SOURCE:', url.includes('a2p') ? 'a2p-sms' : 'message-store');
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`(${url.includes('a2p') ? 'a2p-sms' : 'message-store'} -> HTTP ${status})`);
  }
  console.error('Message not found in either message-store or a2p-sms for id', id);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
