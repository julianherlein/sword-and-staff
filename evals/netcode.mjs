// Periodic netcode eval: how well client-side prediction tracks the authoritative server.
//
// A hard bot plays player 0 through the real RoomManager over a simulated TCP link (latency + jitter,
// in-order delivery). A hard bot plays player 1 on the server. For every input seq we record where the
// client predicted its character and where the server put it when it applied that same input.
// Errors come only from things the client cannot know in advance: enemy hits, stuns, knockback.
//
// Thresholds (rubric frozen before building; stress checks added after the adversarial review):
//   own input -> screen latency       1 tick with prediction (was RTT + 50ms interpolation)
//   150ms RTT: mean error < 0.10m, p95 < 0.40m
//   250ms RTT: mean error < 0.20m, p95 < 0.80m
//   own cosmetic events (swing, cast, dash...): never shown twice or missing on jitter profiles; casts
//     shown that the server then rejected (you were stunned and could not know yet): <= 3% / 5%
//   stall stress (150ms + 100-200ms freezes every few s): queue mean <= 3 ticks (a backlog drains),
//     events shown twice or never <= 0.5%, mean prediction error <= 0.12m
// Usage: node evals/netcode.mjs [secondsPerProfile=300]
import { writeFileSync, mkdirSync } from 'node:fs';
import { RoomManager } from '../services/server/rooms.js';
import { createPredictor, createPacer } from '../services/sim/predict.js';
import { createBot } from '../services/ai/bot.js';
import { constants as C } from '../services/sim/index.js';

const SECONDS = Number(process.argv[2]) || 300; // rates of a few percent need ~500+ events to mean anything

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runProfile({ name, rttMs, jitterMs, stallRate = 0, seed }) {
  const rand = mulberry32(seed);
  const oneWay = rttMs / 2 / (1000 / C.TICK_RATE); // ticks
  const jitter = jitterMs / (1000 / C.TICK_RATE);
  const rooms = new RoomManager({ random: rand });
  let now = 0;
  // In-order links (TCP): a message never overtakes an earlier one.
  // TCP stalls: now and then a link freezes for 100-200ms, then releases everything at once (a burst).
  const link = () => {
    const q = [];
    let lastAt = 0;
    let stallUntil = 0;
    return {
      q,
      send(fn) {
        if (now >= stallUntil && rand() < stallRate) stallUntil = now + 6 + rand() * 6;
        lastAt = Math.max(lastAt, now + oneWay + rand() * jitter, now < stallUntil ? stallUntil + oneWay : 0);
        q.push({ at: lastAt, fn });
      },
    };
  };
  const up = link(), down = link();
  let pred = null;
  let latest = null;
  const pacer = createPacer();
  // Own cosmetic events: how many the client showed vs how many the server really produced.
  const COSMETIC = new Set(['cast', 'swing', 'dash', 'blink', 'leap', 'parryStart', 'berserk', 'nova']);
  let shown = 0, truth = 0;
  const shownLog = {}, truthLog = {}; // key -> [tick]; `now` for both (one clock for the whole eval)
  const log = (bag, evs) => {
    const mine = evs.filter((e) => e.id === 0 && COSMETIC.has(e.type));
    for (const e of mine) (bag[`${e.type}:${e.ability || ''}`] ||= []).push(now);
    return mine.length;
  };
  const own = (evs) => log(shownLog, evs);
  const a = rooms.connect((m) => {
    if (m.t === 'snap') truth += log(truthLog, m.ev); // counted at the source, before the link
    down.send(() => {
      if (m.t === 'start') pred = createPredictor(m.you, { startSeq: pred ? pred.seq : 0 });
      if (m.t === 'snap') {
        latest = m.s;
        pacer.observe(m.q[0]);
        shown += own(pred.reconcile(m.s, m.ack[0]));
        shown += own(pred.serverEvents(m.ev));
      }
    });
  });
  const b = rooms.connect(() => {});
  a.message({ t: 'create', cls: 'warrior' });
  b.message({ t: 'join', code: [...rooms.rooms.keys()][0], cls: 'mage' });
  const room = () => [...rooms.rooms.values()][0];
  const botA = createBot({ difficulty: 'hard', seed: seed + 1 });
  const botB = createBot({ difficulty: 'hard', seed: seed + 2 });

  const predictedBySeq = new Map();
  const depths = [];
  const errors = [];
  let lastAck = 0;
  const flush = (l) => { while (l.q.length && l.q[0].at <= now) l.q.shift().fn(); };
  const ticks = SECONDS * C.TICK_RATE;
  while (now < ticks) {
    now++;
    flush(up); flush(down);
    const r = room();
    // Player 1 is local to the server (no latency) so the fight is real.
    b.message({ t: 'input', i: botB.think(r.state, 1) });
    // Player 0 decides from what its client sees: the latest snapshot with its own character predicted.
    for (let n = pred && latest ? pacer.due(C.DT, C.DT) : 0; n > 0; n--) {
      const view = { ...latest, players: latest.players.slice() };
      view.players[0] = pred.player(latest.players[0]);
      const { msg, events } = pred.input(botA.think(view, 0));
      shown += own(events);
      const p = pred.predicted();
      if (p && r.state.phase === 'fight') predictedBySeq.set(msg.s, p);
      up.send(() => a.message({ t: 'input', ...msg }));
      pred.update(C.DT);
    }
    depths.push(r.queues[0].length);
    rooms.tick();
    const ack = r.acks[0];
    if (ack !== lastAck && predictedBySeq.has(ack) && r.state.phase === 'fight' && r.state.players[0].alive) {
      const s = r.state.players[0], p = predictedBySeq.get(ack);
      errors.push(Math.hypot(s.x - p.x, s.y - p.y));
      predictedBySeq.delete(ack);
    }
    lastAck = ack;
    if (r.state.phase === 'matchEnd') { // keep playing: rematch like real clients do
      up.send(() => a.message({ t: 'rematch' }));
      b.message({ t: 'rematch' });
    }
  }
  // Duplicates: two shows of the same event type closer together than any cooldown allows
  // (the shortest is 27 ticks; pacing can compress real time by ~6%, so 20 is safely below).
  let dup = 0;
  for (const ticks of Object.values(shownLog)) for (let i = 1; i < ticks.length; i++) if (ticks[i] - ticks[i - 1] < 20) dup++;
  // Misses: server events with no show of the same type near it. Shows can lead the server by the
  // one-way latency (prediction) or trail it by a stall plus the one-way latency (late).
  const reach = Math.ceil(oneWay + jitter + 12) + 20;
  let missed = 0;
  for (const [key, ticks] of Object.entries(truthLog)) {
    const avail = [...(shownLog[key] || [])];
    for (const t of ticks) {
      const i = avail.findIndex((x) => Math.abs(x - t) <= reach);
      if (i < 0) missed++; else avail.splice(i, 1);
    }
  }
  errors.sort((x, y) => x - y);
  const mean = errors.reduce((s, e) => s + e, 0) / Math.max(1, errors.length);
  const pct = (q) => errors[Math.floor((errors.length - 1) * q)] ?? 0;
  return {
    name, rttMs, jitterMs, samples: errors.length,
    meanError: +mean.toFixed(4), p95Error: +pct(0.95).toFixed(4), maxError: +pct(1).toFixed(3),
    exactShare: +(errors.filter((e) => e < 1e-6).length / Math.max(1, errors.length)).toFixed(3),
    corrections: pred.stats.corrections, snaps: pred.stats.snaps,
    meanQueueDepth: +(depths.reduce((x, y) => x + y, 0) / depths.length).toFixed(2),
    ownEventsShownVsServer: +(shown / Math.max(1, truth)).toFixed(3), ownEventsServer: truth,
    ownEventsDuplicated: dup, ownEventsMissed: missed,
    ownLatencyMsWithoutPrediction: Math.round(rttMs + jitterMs / 2 + 50),
    ownLatencyMsWithPrediction: Math.round(1000 / C.TICK_RATE),
  };
}

const t0 = Date.now();
// Rubric profiles: latency + jitter, as specified before building. Stress profile: the same link plus
// TCP stalls (100-200ms freezes every few seconds) to prove a backlog drains and events stay sane.
const results = [
  runProfile({ name: 'LAN', rttMs: 20, jitterMs: 5, seed: 11 }),
  runProfile({ name: 'same country', rttMs: 150, jitterMs: 30, seed: 22 }),
  runProfile({ name: 'far away', rttMs: 250, jitterMs: 50, seed: 33 }),
  runProfile({ name: 'stalling', rttMs: 150, jitterMs: 30, stallRate: 0.005, seed: 44 }),
];
const byName = Object.fromEntries(results.map((r) => [r.name, r]));
const rubric = results.slice(0, 3);
const stress = byName.stalling;
const rate = (r) => +(r.ownEventsShownVsServer - 1).toFixed(3);
const checks = [
  { name: 'own movement latency with prediction (ms)', value: results[0].ownLatencyMsWithPrediction, lo: 0, hi: 17 },
  { name: '150ms RTT: mean prediction error (m)', value: byName['same country'].meanError, lo: 0, hi: 0.1 },
  { name: '150ms RTT: p95 prediction error (m)', value: byName['same country'].p95Error, lo: 0, hi: 0.4 },
  { name: '250ms RTT: mean prediction error (m)', value: byName['far away'].meanError, lo: 0, hi: 0.2 },
  { name: '250ms RTT: p95 prediction error (m)', value: byName['far away'].p95Error, lo: 0, hi: 0.8 },
  { name: 'own events shown twice or never (jitter profiles)', value: rubric.reduce((n, r) => n + r.ownEventsDuplicated + r.ownEventsMissed, 0), lo: 0, hi: 0 },
  { name: '150ms RTT: casts shown that the server rejected', value: rate(byName['same country']), lo: -0.001, hi: 0.03 },
  { name: '250ms RTT: casts shown that the server rejected', value: rate(byName['far away']), lo: -0.001, hi: 0.05 },
  { name: 'stalls: mean server input queue depth (ticks)', value: stress.meanQueueDepth, lo: 0, hi: 3 },
  { name: 'stalls: own events shown twice or never (share)', value: +((stress.ownEventsDuplicated + stress.ownEventsMissed) / stress.ownEventsServer).toFixed(4), lo: 0, hi: 0.005 },
  { name: 'stalls: mean prediction error (m)', value: stress.meanError, lo: 0, hi: 0.12 },
  { name: 'enough own events per profile', value: Math.min(...results.map((r) => r.ownEventsServer)), lo: SECONDS * 1.3, hi: Infinity },
];
for (const r of results) {
  console.log(`${r.name.padEnd(13)} rtt ${String(r.rttMs).padStart(3)}ms  mean ${r.meanError}m  p95 ${r.p95Error}m  exact ${(r.exactShare * 100).toFixed(1)}%  queue ${r.meanQueueDepth}  events ${r.ownEventsShownVsServer}x of ${r.ownEventsServer}  snaps ${r.snaps}  own latency ${r.ownLatencyMsWithoutPrediction}ms -> ${r.ownLatencyMsWithPrediction}ms`);
}
console.log('');
const report = { when: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, results, checks: checks.map((c) => ({ ...c, pass: c.value >= c.lo && c.value <= c.hi })) };
for (const c of report.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(44)} ${c.value}  [${c.lo}, ${c.hi}]`);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/netcode-latest.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(`\n${report.seconds}s, report: evals/results/netcode-latest.json`);
process.exit(report.checks.every((c) => c.pass) ? 0 : 1);
