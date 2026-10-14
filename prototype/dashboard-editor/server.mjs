import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.replace(/^\//, '') || 'index.html';
  if (!['index.html', 'prototype.css', 'prototype.js'].includes(name)) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': `${types[extname(name)]}; charset=utf-8` });
  response.end(await readFile(join(root, name)));
}).listen(4173, '127.0.0.1', () => {
  console.log('Prototype: http://127.0.0.1:4173/?variant=A');
});
