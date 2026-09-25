// End-to-end on the real Cloudflare runtime (workerd, started by wrangler), not a mock: the Worker,
// Static Assets and the GameServer Durable Object, reached over real HTTP and WebSockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { unstable_startWorker } from 'wrangler';

const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../wrangler.toml');
let worker, base;

before(async () => {
  worker = await unstable_startWorker({ config: CONFIG, dev: { server: { port: 0 }, inspector: false, watch: false, logLevel: 'none' } });
  base = await worker.url;
});
after(async () => { await worker?.dispose(); });

const get = (p) => fetch(new URL(p, base));

function connect(headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(new URL('/ws', base).href.replace(/^http/, 'ws'), { headers });
    const c = { ws, inbox: [], waiters: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.inbox.push(m);
      c.waiters = c.waiters.filter((w) => !(w.t === m.t && (w.resolve(m), true)));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
// The next message of type t that arrives from now on.
const next = (c, t, ms = 2000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no '${t}' within ${ms}ms`)), ms);
  c.waiters.push({ t, resolve: (m) => { clearTimeout(timer); resolve(m); } });
});
const send = (c, obj) => c.ws.send(JSON.stringify(obj));

test('serves the game page and its modules', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script type="importmap">/);
  for (const p of ['/services/client/js/main.js', '/services/sim/index.js', '/contracts/protocol.js', '/node_modules/three/build/three.module.js']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /javascript/, p);
  }
});

test('private files are not served', async () => {
  for (const p of ['/services/server/index.js', '/services/server/rooms.js', '/services/edge/src/worker.js', '/services/sim/test/sim.test.js', '/.env', '/package.json', '/.git/config']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('/ws without an upgrade is refused with 426', async () => {
  assert.equal((await get('/ws')).status, 426);
});

test('private room: create, join, start at once, snapshots acknowledge inputs, leaving tells the host', async () => {
  const a = await connect(), b = await connect();
  const created = next(a, 'created');
  send(a, { t: 'create', cls: 'warrior' });
  const { code } = await created;
  const starts = [next(a, 'start'), next(b, 'start')];
  send(b, { t: 'join', code, cls: 'mage' });
  const [sa, sb] = await Promise.all(starts);
  assert.deepEqual([sa.you, sb.you], [0, 1]);
  assert.deepEqual(sb.classes, ['warrior', 'mage']);
  for (let s = 1; s <= 5; s++) send(b, { t: 'input', s, i: { mx: 0, my: 1, ax: 0, ay: 0, b: 0 } });
  let snap;
  do snap = await next(a, 'snap'); while (snap.ack[1] < 5);
  assert.equal(snap.ack[1], 5, 'the Durable Object ticks and applied every input');
  const left = next(a, 'left');
  b.ws.close();
  await left;
  a.ws.close();
});

test('abuse limits on the real runtime: binary frame closed 1003, fifth socket from one IP refused 429', async () => {
  const bin = await connect();
  const closed = new Promise((resolve) => bin.ws.on('close', resolve));
  bin.ws.send(Buffer.alloc(64));
  assert.equal(await closed, 1003);

  // wrangler dev does not overwrite CF-Connecting-IP (Cloudflare does in production), so a test can
  // pose as one non-loopback address.
  const ip = { 'CF-Connecting-IP': '203.0.113.50' };
  const four = await Promise.all([1, 2, 3, 4].map(() => connect(ip)));
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(new URL('/ws', base).href.replace(/^http/, 'ws'), { headers: ip });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => {});
  });
  assert.equal(status, 429);
  for (const c of four) c.ws.close();
});

test('queue: both see match found, and a drop during the countdown puts the other back in line', async () => {
  const a = await connect(), b = await connect();
  const queued = next(a, 'queued');
  send(a, { t: 'queue', cls: 'mage' });
  await queued;
  const found = [next(a, 'found'), next(b, 'found')];
  send(b, { t: 'queue', cls: 'warrior' });
  const [fa, fb] = await Promise.all(found);
  assert.deepEqual([fa.you, fb.you, fa.secs], [0, 1, 5]);
  const requeued = next(a, 'queued');
  b.ws.close();
  await requeued;
  a.ws.close();
});
