import express, { type Express } from 'express';
import { resolve } from 'node:path';
import { checkDatabase } from '../db/client.js';
import { createAuthRouter, requireSameOriginForCookieMutations, type SigninRateLimitOptions, type SignupRateLimitOptions } from './auth.js';
import { createDocumentsRouter } from './documents.js';
import { draftSaveHandler } from './http/draft-save.js';
import { createReportsRouter } from './reports.js';
import { systemClock, type Clock } from './clock.js';

export type DatabaseCheck = () => Promise<void>;

export interface AppOptions {
  signupRateLimit?: SignupRateLimitOptions;
  signinRateLimit?: SigninRateLimitOptions;
}

export function createApp(
  databaseCheck: DatabaseCheck = checkDatabase,
  clock: Clock = systemClock,
  options: AppOptions = {},
): Express {
  const app = express();

  app.use(requireSameOriginForCookieMutations);
  app.use('/auth', createAuthRouter(clock, options.signupRateLimit, options.signinRateLimit));
  app.post('/documents/draft-save', ...draftSaveHandler(clock));
  app.use('/documents', createDocumentsRouter(clock));
  app.use('/reports', createReportsRouter(clock));

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
      ? error.status
      : undefined;
    if (status === 413) {
      response.status(413).json({
        error: { code: 'request_too_large', message: 'Request is too large. Shorten text or remove items and try again.' },
      });
      return;
    }
    if (status === 415) {
      response.status(415).json({
        error: { code: 'unsupported_encoding', message: 'Send UTF-8 JSON with a supported content encoding.' },
      });
      return;
    }
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

    let cause = error;
    while (cause && typeof cause === 'object') {
      if ('code' in cause && cause.code === '22021') {
        response.status(422).json({
          error: {
            code: 'validation_failed',
            message: 'Check the highlighted fields.',
            fields: { body: 'Remove unsupported control characters.' },
          },
        });
        return;
      }
      cause = 'cause' in cause ? cause.cause : undefined;
    }

    response.status(500).json({
      error: { code: 'internal_error', message: 'Request failed.' },
    });
  });

  return app;
}
