import { createApp } from './app.js';
import { closeDatabase } from '../db/client.js';

const port = Number(process.env.API_PORT ?? 4174);
const playwrightTestOptions = process.env.PRICING_PLAYWRIGHT_TEST === '1'
  ? { signupRateLimit: { maxRequests: 100 }, signinRateLimit: { maxRequests: 100 } }
  : {};
const server = createApp(undefined, undefined, playwrightTestOptions).listen(port, '127.0.0.1', () => {
  console.log(`API listening on http://127.0.0.1:${port}`);
});

async function shutdown(): Promise<void> {
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
