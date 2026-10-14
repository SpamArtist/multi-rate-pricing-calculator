import { createApp } from './app.js';
import { pool } from '../db/client.js';

const port = Number(process.env.API_PORT ?? 4174);
const server = createApp().listen(port, '127.0.0.1', () => {
  console.log(`API listening on http://127.0.0.1:${port}`);
});

async function shutdown(): Promise<void> {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
