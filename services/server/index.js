// Game server: serves the browser client and hosts online 1v1 rooms over WebSocket (/ws).
// Usage: node services/server/index.js [--port 8080] [--lag 150]   (or PORT=8080)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { createPresence } from './presence.js';
import { createTicker } from './ticker.js';
import { TICK_RATE } from '../sim/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Only these trees are reachable over HTTP. Everything else (evals, .git, .env) is not served.
export const PUBLIC = ['services/client/', 'services/sim/', 'services/ai/', 'contracts/', 'node_modules/three/build/', 'node_modules/three/examples/jsm/'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

export function resolvePublic(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, ''); } catch { return null; }
  if (rel === '' ) rel = 'services/client/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = path.resolve(ROOT, rel);
  const norm = path.relative(ROOT, abs).split(path.sep).join('/');
  if (norm.startsWith('..') || !PUBLIC.some((p) => norm.startsWith(p))) return null;
  if (norm.split('/').includes('test')) return null;
  return abs;
}

// `lagMs` (dev only): simulated round-trip latency added to every WebSocket message, half each way.
// `matchFoundSecs`: countdown between a queue pairing and the match start (tests shorten it).
// `log`: where the connection log goes (who connected, queued, matched, left). Silent by default;
// the CLI and `npm run share` pass console.log.
export function createServer({ lagMs = 0, matchFoundSecs, log = null } = {}) {
  const presence = createPresence({ log: log || (() => {}) });
  const rooms = new RoomManager({ matchFoundSecs, onEvent: (e) => presence.room(e) });
  const server = http.createServer(async (req, res) => {
    const file = resolvePublic(req.url);
    if (!file) { res.writeHead(404).end('not found'); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  wss.on('connection', (ws, req) => {
    const delay = (fn) => (lagMs > 0 ? setTimeout(fn, lagMs / 2) : fn()); // equal delays keep order
    const send = (obj) => {
      const data = JSON.stringify(obj);
      delay(() => { if (ws.readyState === ws.OPEN) ws.send(data); });
    };
    const id = presence.connect(req);
    const conn = rooms.connect(send, id);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      delay(() => conn.message(msg));
    });
    ws.on('close', () => {
      presence.disconnect(id);
      delay(conn.close); // same delay as messages, so a lagged join cannot outlive its socket
    });
  });

  // Poll faster than the tick rate; the ticker decides how many sim ticks real time allows.
  const advance = createTicker(() => rooms.tick(), TICK_RATE);
  const loop = setInterval(advance, 4);
  server.on('close', () => { clearInterval(loop); wss.close(); });
  return { server, rooms, presence };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argPort = process.argv.indexOf('--port');
  const port = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT) || 8080;
  const argLag = process.argv.indexOf('--lag');
  const lagMs = argLag > 0 ? Number(process.argv[argLag + 1]) || 0 : 0;
  const { server } = createServer({ lagMs, log: console.log });
  server.listen(port, () => {
    console.log(`Arena Duel running:  http://localhost:${port}`);
    if (lagMs) console.log(`  simulating ${lagMs}ms round-trip latency on every connection (dev)`);
    for (const ip of lanAddresses()) console.log(`  on your network:    http://${ip}:${port}`);
    console.log('Connections are logged below (+ connect, - disconnect).');
  });
}
