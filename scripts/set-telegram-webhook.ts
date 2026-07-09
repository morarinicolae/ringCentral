import { config } from '../src/config';

/**
 * Register the Telegram webhook so seller replies reach POST /webhooks/telegram.
 * Run once after deploy: `npm run set-telegram-webhook`.
 * Requires TELEGRAM_BOT_TOKEN and APP_BASE_URL (public https URL).
 */
async function main() {
  if (!config.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
  if (!config.appBaseUrl) throw new Error('APP_BASE_URL is not set (public https URL of this service).');

  const url = `${config.appBaseUrl.replace(/\/$/, '')}/webhooks/telegram`;
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      ...(config.telegram.webhookSecret ? { secret_token: config.telegram.webhookSecret } : {}),
      allowed_updates: ['message'],
    }),
  });
  const json = await res.json();
  // eslint-disable-next-line no-console
  console.log('setWebhook ->', url);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(json, null, 2));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
