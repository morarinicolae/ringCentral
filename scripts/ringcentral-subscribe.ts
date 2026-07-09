import 'dotenv/config';
import { config } from '../src/config';
import {
  createInboundSmsSubscription,
  listSubscriptions,
  deleteSubscription,
  renewSubscription,
} from '../src/services/ringcentral-connect';

/**
 * Manage the inbound-SMS webhook subscription.
 *
 *   npm run rc:subscribe -- list           # list current subscriptions
 *   npm run rc:subscribe -- create         # create SMS webhook -> APP_BASE_URL/webhooks/ringcentral/sms
 *   npm run rc:subscribe -- renew <id>     # renew before expiry
 *   npm run rc:subscribe -- delete <id>    # remove a subscription
 *
 * `create` requires a PUBLIC https APP_BASE_URL (RingCentral must be able to
 * reach the webhook). RingCentral first sends a validation request that our
 * /webhooks/ringcentral/sms route echoes back automatically.
 */
async function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'list') {
    const r = await listSubscriptions();
    console.log(JSON.stringify(r.json, null, 2));
    return;
  }

  if (cmd === 'create') {
    if (!config.appBaseUrl || !config.appBaseUrl.startsWith('https://')) {
      throw new Error('APP_BASE_URL must be a public https URL to receive RingCentral webhooks.');
    }
    const webhookUrl = `${config.appBaseUrl.replace(/\/$/, '')}/webhooks/ringcentral/sms`;
    const r = await createInboundSmsSubscription(webhookUrl);
    console.log('Webhook target:', webhookUrl);
    console.log('Result:', JSON.stringify(r.json, null, 2));
    if (!r.ok) process.exit(1);
    console.log('\n✅ Subscription created. Inbound SMS will now POST to your webhook.');
    return;
  }

  if (cmd === 'renew') {
    if (!arg) throw new Error('Usage: rc:subscribe -- renew <subscriptionId>');
    console.log(JSON.stringify((await renewSubscription(arg)).json, null, 2));
    return;
  }

  if (cmd === 'delete') {
    if (!arg) throw new Error('Usage: rc:subscribe -- delete <subscriptionId>');
    const r = await deleteSubscription(arg);
    console.log(r.ok ? `Deleted ${arg}` : `Failed: ${JSON.stringify(r.json)}`);
    return;
  }

  console.log('Usage: rc:subscribe -- <list|create|renew <id>|delete <id>>');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
