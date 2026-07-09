import { defineConfig } from 'vitest/config';
import path from 'path';

// Absolute path so the Prisma CLI (db push) and the Prisma Client resolve the
// SAME SQLite file regardless of how relative `file:` URLs are interpreted.
const TEST_DB = path.join(process.cwd(), 'prisma', 'test.db');

export default defineConfig({
  // This project is nested inside a Next.js repo. Give Vite an inline (empty)
  // PostCSS config so it does NOT walk up and load the parent repo's
  // postcss.config.js (which pulls in tailwind and isn't installed here).
  css: { postcss: { plugins: [] } },
  test: {
    globals: true,
    environment: 'node',
    // A single SQLite test DB file is shared across test files. Run files
    // sequentially so they never race on the same file, and reset the DB in
    // each test's beforeEach (see src/__tests__/helpers.ts).
    fileParallelism: false,
    globalSetup: ['./src/__tests__/globalSetup.ts'],
    env: {
      NODE_ENV: 'test',
      TEST_MODE: 'true',
      ALLOW_REAL_SMS: 'false',
      DATABASE_URL: `file:${TEST_DB}`,
      RINGCENTRAL_FROM_NUMBER: '+15550009999',
      ADMIN_API_TOKEN: 'test-admin-token',
      ADMIN_TELEGRAM_IDS: '999000',
      // Empty bot token -> telegram service uses its in-memory mock outbox.
      TELEGRAM_BOT_TOKEN: '',
      // Keep retry backoff tiny so failure tests stay fast.
      SMS_RETRY_BASE_MS: '1',
      // Pin RingCentral vars so a developer's local .env can't leak into the
      // suite (dotenv never overrides an already-set var).
      RINGCENTRAL_USE_A2P: 'false',
      RINGCENTRAL_JWT: '',
      RINGCENTRAL_CLIENT_ID: 'test-client',
      RINGCENTRAL_CLIENT_SECRET: 'test-secret',
      RINGCENTRAL_SERVER_URL: 'https://platform.ringcentral.com',
    },
  },
});
