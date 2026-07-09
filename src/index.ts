import { config, assertConfig } from './config';
import { logger } from './logger';
import { createServer } from './server';
import { startPolling } from './poller';

function main(): void {
  assertConfig();
  const app = createServer();
  app.listen(config.port, () => {
    logger.info('server_started', {
      port: config.port,
      env: config.nodeEnv,
      testMode: config.testMode,
      allowRealSms: config.allowRealSms,
      pollMode: config.pollMode,
    });
    // Always visible, even in non-test: a friendly boot line.
    // eslint-disable-next-line no-console
    console.log(
      `SMS router listening on :${config.port} (env=${config.nodeEnv}, TEST_MODE=${config.testMode}, ALLOW_REAL_SMS=${config.allowRealSms}, POLL_MODE=${config.pollMode})`,
    );
    // Single-process deploy: also poll Telegram + A2P inbound (no public URL needed).
    if (config.pollMode) {
      startPolling().catch((err) => logger.error('polling_start_failed', { error: err?.message }));
    }
  });
}

main();
