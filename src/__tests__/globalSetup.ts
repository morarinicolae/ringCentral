import { execSync } from 'child_process';
import path from 'path';

// Runs ONCE before the whole test suite. Creates a fresh SQLite schema in the
// test DB via `prisma db push --force-reset`. Individual tests then wipe rows
// in beforeEach (see helpers.ts) for isolation.
export default async function setup() {
  const testDb = path.join(process.cwd(), 'prisma', 'test.db');
  const databaseUrl = `file:${testDb}`;

  execSync('npx prisma db push --force-reset --skip-generate --accept-data-loss', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
