import express, { type Express } from 'express';
import { resolve } from 'node:path';
import { checkDatabase } from '../db/client.js';
import { createAuthRouter, type SignupRateLimitOptions } from './auth.js';
import { systemClock, type Clock } from './clock.js';

export type DatabaseCheck = () => Promise<void>;

export interface AppOptions {
  signupRateLimit?: SignupRateLimitOptions;
}

export function createApp(
  databaseCheck: DatabaseCheck = checkDatabase,
  clock: Clock = systemClock,
  options: AppOptions = {},
): Express {
  const app = express();

  app.use('/auth', createAuthRouter(clock, options.signupRateLimit));

  app.get('/health', async (_request, response) => {
    try {
      await databaseCheck();
      response.status(200).json({
        status: 'ok',
        database: 'ok',
        checkedAt: clock.now().toISOString(),
      });
    } catch {
      response.status(503).json({
        error: {
          code: 'database_unavailable',
          message: 'Database unavailable.',
        },
      });
    }
  });

  const webRoot = resolve('dist/web');
  app.use(express.static(webRoot));
  app.get('/', (_request, response) => response.sendFile(resolve(webRoot, 'index.html')));

  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const status = error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
    if (status === 400) {
      response.status(422).json({
        error: {
          code: 'validation_failed',
          message: 'Check the highlighted fields.',
          fields: { body: 'Send valid JSON.' },
        },
      });
      return;
    }

    response.status(500).json({
      error: { code: 'internal_error', message: 'Request failed.' },
    });
  });

  return app;
}
