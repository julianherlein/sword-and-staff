// Periodic eval: does the game server keep time and stay playable when it runs on Cloudflare?
//
// Two real WebSocket clients play a queued match against a running server (wrangler dev locally, or
// the deployed workers.dev URL), sending inputs the way the browser does (paced by createPacer from
// the server-reported queue depth). Nothing is simulated: this measures the real runtime's timers.
//
// Thresholds (frozen before the first run):
//   matchmaking: queued, then found for both, then start 5s later (4.8s .. 5.6s)
//   sim clock:   server ticks per wall second within 2% of 60 (58.8 .. 61.2)
//   snapshots:   interval p95 <= 50ms (nominal 33ms), none further apart than 250ms
//   inputs:      mean server queue depth <= 3 (the backlog drains, as in evals/netcode.mjs)
//   leaving:     the other player gets {t:'left'} within 1s
//   hostile:     3s in, three extra clients (one after another) send a 1MB binary frame, 5000 frames at once, and 12KB of
//                multibyte text. Each is closed (1003, 1008, 1009) and the match above still passes.
// Input -> ack latency (includes network RTT) is reported, not judged: it depends on where you are.
// Usage: node evals/edge.mjs [url=ws://127.0.0.1:8787/ws] [seconds=20]
//   url can be the page (https://x.workers.dev) or the socket (wss://x.workers.dev/ws).
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';
import { createPacer } from '../services/sim/predict.js';
import { constants as C } from '../services/sim/index.js';
import { MSG } from '../contracts/protocol.js';

export function socketUrl(raw) {
  const u = new URL(raw);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.pathname !== '/ws') u.pathname = '/ws';
  return u.toString();
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const URL_ARG = socketUrl(process.argv[2] || 'ws://127.0.0.1:8787/ws');
const SECONDS = Number(process.argv[3]) || 20;

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_ARG);
    const c = { name, ws, inbox: [], waiters: [] };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      msg.at = performance.now();
      c.inbox.push(msg);
      c.onMsg?.(msg);
      c.waiters = c.waiters.filter((w) => !(w.t === msg.t && (w.resolve(msg), true)));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

function next(c, t, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${c.name}: no '${t}' within ${ms}ms (got ${c.inbox.map((m) => m.t).join(',') || 'nothing'})`)), ms);
    c.waiters.push({ t, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
}

const send = (c, obj) => c.ws.send(JSON.stringify(obj));

async function run() {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };

  const a = await client('A');
  const b = await client('B');
  const queued = next(a, MSG.QUEUED, 3000);
  send(a, { t: MSG.QUEUE, cls: 'mage' });
  await queued;
  const found = [next(a, MSG.FOUND, 3000), next(b, MSG.FOUND, 3000)];
  const started = [next(a, MSG.START, 8000), next(b, MSG.START, 8000)];
  send(b, { t: MSG.QUEUE, cls: 'warrior' });
  const [fa] = await Promise.all(found);
  const [sa] = await Promise.all(started);
  const countdown = (sa.at - fa.at) / 1000;
  check('matchmaking', countdown >= 4.8 && countdown <= 5.6, `queued -> found -> start after ${countdown.toFixed(2)}s`);

  // Play: both clients send inputs like the browser does, walking in circles and tapping attack.
  const players = [a, b].map((c, slot) => ({ c, slot, seq: 0, pacer: createPacer(), sentAt: new Map(), lat: [], depth: [] }));
  for (const p of players) {
    p.c.onMsg = (m) => {
      if (m.t !== MSG.SNAP) return;
      p.pacer.observe(m.q[p.slot]);
      p.depth.push(m.q[p.slot]);
      for (const [seq, at] of p.sentAt) if (seq <= m.ack[p.slot]) { p.lat.push(m.at - at); p.sentAt.delete(seq); }
    };
  }
  // Hostile clients join 3s into the match. The match above must keep every threshold regardless.
  const attacks = [
    { name: '1MB binary frame', code: 1003, go: (ws) => ws.send(Buffer.alloc(1024 * 1024)) }, // refused by type, any size
    { name: 'flood of 5000 frames', code: 1008, go: (ws) => { for (let i = 0; i < 5000; i++) ws.send('{"t":"input","s":1}'); } },
    { name: '12KB multibyte text', code: 1009, go: (ws) => ws.send(JSON.stringify({ t: 'x', pad: '€'.repeat(4000) })) },
  ];
  // One at a time: with the two players that is 3 sockets from this machine, under the deployed
  // server's limit of 4 per IP (loopback is exempt, so only a production run would notice).
  const attackOnce = (atk) => new Promise((done) => {
    const ws = new WebSocket(URL_ARG);
    const timer = setTimeout(() => { ws.terminate(); done({ ...atk, got: 'still open after 30s' }); }, 30000);
    ws.on('open', () => atk.go(ws));
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); done({ ...atk, got: `refused with HTTP ${res.statusCode}` }); });
    ws.on('close', (code) => { clearTimeout(timer); done({ ...atk, got: code }); });
    ws.on('error', () => {});
  });
  const attacked = new Promise((resolve) => setTimeout(async () => {
    const results = [];
    for (const atk of attacks) results.push(await attackOnce(atk));
    resolve(results);
  }, 3000));

  const t0 = performance.now();
  let last = t0;
  await new Promise((resolve) => {
    const loop = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      for (const p of players) {
        for (let n = p.pacer.due(dt, C.DT); n > 0; n--) {
          const s = ++p.seq;
          const ang = s / 60 + p.slot * Math.PI;
          send(p.c, { t: MSG.INPUT, s, i: { mx: Math.cos(ang), my: Math.sin(ang), ax: 0, ay: 0, b: s % 30 === 0 ? 1 : 0 } });
          p.sentAt.set(s, now);
        }
      }
      if (now - t0 >= SECONDS * 1000) { clearInterval(loop); resolve(); }
    }, 4);
  });

  for (const atk of await attacked) {
    check(`hostile: ${atk.name}`, atk.got === atk.code, `closed with ${atk.got} (want ${atk.code})`);
  }

  const snaps = a.inbox.filter((m) => m.t === MSG.SNAP && m.at >= t0);
  if (snaps.length < 2) {
    check('snapshots', false, `only ${snaps.length} snapshots in ${SECONDS}s`);
    return finish(checks, {});
  }
  const wall = (snaps.at(-1).at - snaps[0].at) / 1000;
  const rate = (snaps.at(-1).s.tick - snaps[0].s.tick) / wall;
  check('sim clock', rate >= 58.8 && rate <= 61.2, `${rate.toFixed(2)} ticks/s over ${wall.toFixed(1)}s (target 60)`);

  const gaps = snaps.slice(1).map((m, i) => m.at - snaps[i].at).sort((x, y) => x - y);
  const p50 = quantile(gaps, 0.5), p95 = quantile(gaps, 0.95), max = gaps.at(-1);
  check('snapshots', p95 <= 50 && max <= 250, `${snaps.length} snaps, interval p50 ${p50.toFixed(1)}ms p95 ${p95.toFixed(1)}ms max ${max.toFixed(1)}ms`);

  const depth = players.flatMap((p) => p.depth);
  const meanDepth = depth.reduce((x, y) => x + y, 0) / depth.length;
  check('input queue', meanDepth <= 3, `mean server queue depth ${meanDepth.toFixed(2)} ticks, ${players.map((p) => p.seq).join('/')} inputs sent`);

  const lat = players.flatMap((p) => p.lat).sort((x, y) => x - y);
  console.log(`info  input -> ack latency p50 ${quantile(lat, 0.5).toFixed(0)}ms p95 ${quantile(lat, 0.95).toFixed(0)}ms (network RTT + server queue)`);

  const left = next(a, MSG.LEFT, 1000);
  const tLeave = performance.now();
  b.ws.close();
  try {
    const m = await left;
    check('leaving', true, `A told after ${(m.at - tLeave).toFixed(0)}ms`);
  } catch (err) {
    check('leaving', false, err.message);
  }
  a.ws.close();

  finish(checks, {
    countdown, simRate: rate, snapshotMs: { p50, p95, max, count: snaps.length }, meanQueueDepth: meanDepth,
    ackLatencyMs: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95) },
  });
}

// Always writes a results file and exits with the verdict, including on a run with no snapshots.
function finish(checks, metrics) {
  const result = { url: URL_ARG, seconds: SECONDS, when: new Date().toISOString(), ...metrics, checks };
  mkdirSync('evals/results', { recursive: true });
  const file = `evals/results/edge-${new URL(URL_ARG).host.replace(/[^a-z0-9.-]/gi, '_')}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(result, null, 2));
  const failed = checks.filter((x) => !x.ok).length;
  console.log(`\n${failed ? `FAILED ${failed}/${checks.length}` : `ALL ${checks.length} PASSED`}  (${file})`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
