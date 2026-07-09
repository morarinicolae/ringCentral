import { config, assertConfig } from './config';
import { logger } from './logger';
import { createServer } from './server';

function main(): void {
  assertConfig();
  const app = createServer();
  app.listen(config.port, () => {
    logger.info('server_started', {
      port: config.port,
      env: config.nodeEnv,
      testMode: config.testMode,
      allowRealSms: config.allowRealSms,
    });
    // Always visible, even in non-test: a friendly boot line.
    // eslint-disable-next-line no-console
    console.log(
      `SMS router listening on :${config.port} (env=${config.nodeEnv}, TEST_MODE=${config.testMode}, ALLOW_REAL_SMS=${config.allowRealSms})`,
    );
  });
}

main();
