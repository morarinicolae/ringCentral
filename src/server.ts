import express, { Express, NextFunction, Request, Response } from 'express';
import { config } from './config';
import { logger } from './logger';
import { webhooksRouter } from './routes/webhooks';
import { testRouter } from './routes/test';
import { adminRouter } from './routes/admin';
import { sellerRouter } from './routes/seller';
import { panelRouter } from './routes/panel';

export function createServer(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'sms-router',
      env: config.nodeEnv,
      test_mode: config.testMode,
      allow_real_sms: config.allowRealSms,
    });
  });

  app.use('/webhooks', webhooksRouter);
  app.use('/admin', adminRouter);
  app.use('/seller', sellerRouter);

  // Admin web UI (the page shell is public; every data call it makes carries
  // the admin token the user enters, and hits the token-protected /admin/* API).
  app.use('/panel', panelRouter);

  // The test/simulate endpoints are only mounted when TEST_MODE is on, so a
  // production instance never exposes the SMS simulator.
  if (config.testMode) {
    app.use('/test', testRouter);
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Centralized error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled_error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
