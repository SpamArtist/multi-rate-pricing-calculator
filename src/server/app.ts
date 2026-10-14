import express, { type Express } from 'express';
import { resolve } from 'node:path';
import { checkDatabase } from '../db/client.js';
import { systemClock, type Clock } from './clock.js';

export type DatabaseCheck = () => Promise<void>;

export function createApp(
  databaseCheck: DatabaseCheck = checkDatabase,
  clock: Clock = systemClock,
): Express {
  const app = express();

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

  return app;
}
