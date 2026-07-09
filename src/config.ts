import dotenv from 'dotenv';

dotenv.config();

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isTest: (process.env.NODE_ENV ?? 'development') === 'test',
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
  appBaseUrl: process.env.APP_BASE_URL ?? '',

  // TEST_MODE: never send real SMS unless ALLOW_REAL_SMS is also true.
  testMode: bool(process.env.TEST_MODE, true),
  allowRealSms: bool(process.env.ALLOW_REAL_SMS, false),

  ringcentral: {
    clientId: process.env.RINGCENTRAL_CLIENT_ID ?? '',
    clientSecret: process.env.RINGCENTRAL_CLIENT_SECRET ?? '',
    serverUrl: process.env.RINGCENTRAL_SERVER_URL ?? 'https://platform.ringcentral.com',
    username: process.env.RINGCENTRAL_USERNAME ?? '',
    extension: process.env.RINGCENTRAL_EXTENSION ?? '',
    password: process.env.RINGCENTRAL_PASSWORD ?? '',
    fromNumber: process.env.RINGCENTRAL_FROM_NUMBER ?? '',
    // Optional JWT (RingCentral is deprecating password grant). If set, JWT
    // bearer flow is used instead of password grant.
    jwt: process.env.RINGCENTRAL_JWT ?? '',
    // Send via the A2P High Volume SMS API (required for TCR/10DLC-registered
    // accounts) instead of the classic per-extension /sms endpoint.
    useA2p: ['1', 'true', 'yes', 'on'].includes((process.env.RINGCENTRAL_USE_A2P ?? '').trim().toLowerCase()),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    // Optional shared secret echoed by Telegram in the
    // X-Telegram-Bot-Api-Secret-Token header when you register the webhook.
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  },

  // Comma-separated list of Telegram user IDs that are treated as admins.
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Minimal HTTP auth for admin endpoints (MVP). Sent as `X-Admin-Token`.
  adminApiToken: process.env.ADMIN_API_TOKEN ?? '',

  // Outbound SMS retry policy (temporary errors only).
  smsMaxRetries: int(process.env.SMS_MAX_RETRIES, 3),
  smsRetryBaseMs: int(process.env.SMS_RETRY_BASE_MS, 500),
};

export type AppConfig = typeof config;

/**
 * Validate that the environment is coherent for the mode we are running in.
 * Throws in production if a hard requirement is missing. In TEST_MODE we only
 * warn, so the tool boots for local testing without real credentials.
 */
export function assertConfig(): void {
  const problems: string[] = [];

  if (!config.ringcentral.fromNumber) {
    problems.push('RINGCENTRAL_FROM_NUMBER is required (the company number clients text).');
  }

  const willSendRealSms = !config.testMode || config.allowRealSms;
  if (willSendRealSms) {
    if (!config.ringcentral.clientId) problems.push('RINGCENTRAL_CLIENT_ID is required to send real SMS.');
    if (!config.ringcentral.clientSecret) problems.push('RINGCENTRAL_CLIENT_SECRET is required to send real SMS.');
    if (!config.ringcentral.jwt) {
      if (!config.ringcentral.username) problems.push('RINGCENTRAL_USERNAME (or RINGCENTRAL_JWT) is required to send real SMS.');
      if (!config.ringcentral.password) problems.push('RINGCENTRAL_PASSWORD (or RINGCENTRAL_JWT) is required to send real SMS.');
    }
  }

  if (!config.isTest && !config.telegram.botToken) {
    problems.push('TELEGRAM_BOT_TOKEN is required to notify sellers (unset = mock/no-op outbox).');
  }

  if (!config.adminApiToken && !config.isTest) {
    problems.push('ADMIN_API_TOKEN is required to protect /admin endpoints.');
  }

  if (problems.length) {
    const message = `Configuration problems:\n - ${problems.join('\n - ')}`;
    if (config.nodeEnv === 'production') {
      throw new Error(message);
    }
    // In dev/test, warn but keep going so the tool is usable for local testing.
    // eslint-disable-next-line no-console
    console.warn(`[config] WARNING:\n${message}`);
  }
}
