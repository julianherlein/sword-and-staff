import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, step, snapshot, constants as C } from '../index.js';
import { createPredictor } from '../predict.js';
import { BUTTON_BIT } from '../../../contracts/protocol.js';

// Minimal authoritative server: applies inputs one per tick and acks them, like services/server.
function harness({ latencyTicks = 0, remote = () => ({ mx: 0, my: 0, ax: 0, ay: 0, b: 0 }) } = {}) {
  const server = createMatch({ classes: ['warrior', 'mage'] });
  const pred = createPredictor(0);
  const toServer = []; // [{at, msg}]
  const toClient = []; // [{at, snap, ack}]
  const queue = [];
  let ack = 0;
  let last = { mx: 0, my: 0, ax: 0, ay: 0, b: 0 };
  let tick = 0;
  return {
    server, pred,
    tick(raw) {
      tick++;
      const { msg, events } = pred.input(raw);
      toServer.push({ at: tick + latencyTicks, msg });
      while (toServer.length && toServer[0].at <= tick) queue.push(toServer.shift().msg);
      const next = queue.shift();
      if (next) { last = next.i; ack = next.s; }
      step(server, [last, remote(server)]);
      toClient.push({ at: tick + latencyTicks, snap: JSON.parse(JSON.stringify(snapshot(server))), ack });
      while (toClient.length && toClient[0].at <= tick) {
        const m = toClient.shift();
        pred.reconcile(m.snap, m.ack);
      }
      return events;
    },
  };
}

const move = (mx, my, b = 0) => ({ mx, my, ax: 5, ay: 5, b });
const toFight = (h) => { while (h.server.phase !== 'fight') h.tick(move(0, 0)); };

test('prediction is exact when nothing unexpected happens (deterministic replay)', () => {
  const h = harness({ latencyTicks: 6 }); // 100ms each way
  toFight(h);
  for (let i = 0; i < 12; i++) h.tick(move(0, 0)); // let the pipeline settle
  // Walk a curve for 2s. The prediction runs `2 * latency` ticks ahead of the server state it is based on.
  const script = (i) => move(Math.cos(i / 20), Math.sin(i / 20));
  const predictedAt = [];
  for (let i = 0; i < 120; i++) { h.tick(script(i)); predictedAt.push(h.pred.predicted()); }
  // Stop sending new movement and let every input reach the server.
  for (let i = 0; i < 12; i++) h.tick(move(0, 0));
  const p = h.server.players[0];
  const last = h.pred.predicted();
  assert.ok(Math.hypot(p.x - last.x, p.y - last.y) < 1e-9, `server ${p.x},${p.y} vs predicted ${last.x},${last.y}`);
  assert.equal(h.pred.stats.corrections, 0, 'no corrections were needed');
});

test('own movement shows on the very next tick, not after the round trip', () => {
  const h = harness({ latencyTicks: 9 }); // 150ms each way
  toFight(h);
  for (let i = 0; i < 20; i++) h.tick(move(0, 0));
  const x0 = h.pred.player(h.server.players[0]).x;
  h.tick(move(1, 0));
  const x1 = h.pred.predicted().x;
  assert.ok(x1 - x0 > 0.09, `moved ${x1 - x0} on the first tick`);
  assert.ok(Math.abs(h.server.players[0].x - x0) < 1e-9, 'server has not seen the input yet');
});

test('casts and cooldowns are predicted instantly and emitted once as cosmetic events', () => {
  const h = harness({ latencyTicks: 9 });
  toFight(h);
  for (let i = 0; i < 20; i++) h.tick(move(0, 0)); // the fight-phase snapshot has to reach the client first
  const events = h.tick(move(0, 0, BUTTON_BIT.dash));
  assert.ok(events.some((e) => e.type === 'dash' && e.id === 0), 'dash event shown immediately');
  assert.ok(h.pred.player(h.server.players[0]).cd.dash > 0, 'cooldown shown immediately');
  // Replays on later snapshots must not re-emit it.
  let again = 0;
  for (let i = 0; i < 30; i++) again += h.tick(move(0, 0)).filter((e) => e.type === 'dash').length;
  assert.equal(again, 0);
});

test('a server-side surprise (stun) is corrected smoothly, not snapped', () => {
  const h = harness({ latencyTicks: 6 });
  toFight(h);
  for (let i = 0; i < 12; i++) h.tick(move(0, 0));
  for (let i = 0; i < 20; i++) h.tick(move(1, 0));
  h.server.players[0].stun = 0.5; // the enemy stunned us on the server; the client cannot know yet
  const visual = [];
  for (let i = 0; i < 40; i++) {
    h.tick(move(1, 0));
    h.pred.update(C.DT);
    visual.push(h.pred.player(h.server.players[0]).x);
  }
  assert.ok(h.pred.stats.corrections > 0, 'a correction happened');
  assert.equal(h.pred.stats.snaps, 0, 'no hard snap');
  const jumps = visual.slice(1).map((x, i) => Math.abs(x - visual[i]));
  assert.ok(Math.max(...jumps) < 0.35, `largest visual jump per tick ${Math.max(...jumps)}`);
});

test('prediction stays off outside the fight phase', () => {
  const h = harness();
  h.tick(move(1, 0));
  assert.equal(h.pred.predicted(), null);
  const sp = h.server.players[0];
  assert.equal(h.pred.player(sp), sp);
});

test('the prediction state cannot kill anyone or end the round', () => {
  const server = createMatch({ classes: ['warrior', 'mage'] });
  while (server.phase !== 'fight') step(server, []);
  Object.assign(server.players[0], { x: 0, y: 3 });
  Object.assign(server.players[1], { x: 1.5, y: 3, hp: 1 });
  const pred = createPredictor(0);
  pred.reconcile(JSON.parse(JSON.stringify(snapshot(server))), 0);
  // Swing at a 1-hp enemy for a second with no server updates: a real kill would end the round
  // and switch prediction off; the invulnerable prediction state must keep running.
  for (let i = 0; i < 60; i++) pred.input({ mx: 0, my: 0, ax: 5, ay: 3, b: BUTTON_BIT.primary });
  assert.notEqual(pred.predicted(), null);
});

// ---------------------------------------------------------------- review findings (regressions)

// Harness with a server that can repeat (starve) or drop inputs, and full event plumbing.
function eventHarness({ latencyTicks = 6, starve = () => false, drop = () => false } = {}) {
  const server = createMatch({ classes: ['warrior', 'mage'] });
  const pred = createPredictor(0);
  const up = [], down = [], queue = [];
  let ack = 0, last = { mx: 0, my: 0, ax: 0, ay: 0, b: 0 }, tick = 0;
  const shown = {}, truth = {};
  const count = (bag, evs) => { for (const e of evs) if (e.id === 0) bag[`${e.type}:${e.ability || ''}`] = (bag[`${e.type}:${e.ability || ''}`] || 0) + 1; };
  return {
    server, pred, shown, truth,
    tick(raw) {
      tick++;
      const { msg, events } = pred.input(raw);
      count(shown, events);
      up.push({ at: tick + latencyTicks, msg });
      while (up.length && up[0].at <= tick) { const m = up.shift().msg; if (!drop(tick)) queue.push(m); }
      if (!starve(tick) && queue.length) { const n = queue.shift(); last = n.i; ack = n.s; } else last = { ...last, b: 0 };
      step(server, [last, { mx: 0, my: 0, ax: 0, ay: 0, b: 0 }]);
      for (const e of server.events) if (e.id === 0) e.seq = ack; // as services/server does
      const own = server.events.filter((e) => e.id === 0 && ['cast', 'swing', 'dash', 'blink', 'leap', 'parryStart', 'berserk', 'nova'].includes(e.type));
      count(truth, own);
      down.push({ at: tick + latencyTicks, snap: JSON.parse(JSON.stringify(snapshot(server))), ack, ev: server.events });
      while (down.length && down[0].at <= tick) {
        const m = down.shift();
        count(shown, pred.reconcile(m.snap, m.ack));
        count(shown, pred.serverEvents(m.ev).filter((e) => e.id === 0 && ['cast', 'swing', 'dash', 'blink', 'leap', 'parryStart', 'berserk', 'nova'].includes(e.type)));
      }
    },
  };
}

test('own swings are shown exactly once even when the server starves or drops inputs', () => {
  for (const mode of ['starve', 'drop']) {
    const r = mulberry(7);
    const h = eventHarness(mode === 'starve' ? { starve: () => r() < 0.08 } : { drop: () => r() < 0.08 });
    while (h.server.phase !== 'fight') h.tick({ mx: 0, my: 0, ax: 5, ay: 5, b: 0 });
    // Hold attack while strafing for 10s: many windup releases land near replay boundaries.
    for (let i = 0; i < 600; i++) h.tick({ mx: Math.sin(i / 25), my: 0, ax: 5, ay: 5, b: BUTTON_BIT.primary });
    for (let i = 0; i < 30; i++) h.tick({ mx: 0, my: 0, ax: 5, ay: 5, b: 0 });
    assert.ok(h.truth['swing:primary'] > 10, 'enough swings happened');
    // Exact equality is not the contract: a stalled server shifts cooldown timing by a tick, so it may
    // legitimately swing on a different input than predicted. Before the fix, replays lost or doubled
    // 2-3 of every ~25 swings; now each server swing is shown once, give or take one mispredict.
    for (const k of Object.keys(h.truth)) {
      assert.ok(Math.abs((h.shown[k] || 0) - h.truth[k]) <= 1, `${mode} ${k}: shown ${h.shown[k]} vs server ${h.truth[k]}`);
    }
  }
});

test('the first swing right at "FIGHT!" plays instantly (prediction runs through the countdown)', () => {
  const h = harness({ latencyTicks: 9 }); // 300ms round trip
  let shownAt = -1, serverFightAt = -1;
  // Hold attack through the countdown: the client must predict the fight start on its own.
  for (let i = 0; i < C.TICK_RATE * (C.COUNTDOWN + 1) && shownAt < 0; i++) {
    const events = h.tick({ mx: 0, my: 0, ax: 5, ay: 5, b: BUTTON_BIT.primary });
    if (serverFightAt < 0 && h.server.phase === 'fight') serverFightAt = i;
    if (events.some((e) => e.type === 'cast')) shownAt = i;
  }
  assert.ok(shownAt >= 0, 'cast shown');
  // The client runs ahead of the server by the one-way latency, so it may show the cast first.
  for (let i = shownAt + 1; serverFightAt < 0 && i < shownAt + 60; i++) {
    h.tick({ mx: 0, my: 0, ax: 5, ay: 5, b: BUTTON_BIT.primary });
    if (h.server.phase === 'fight') serverFightAt = i;
  }
  // Regression: prediction waited for the fight snapshot, so the first swing appeared a full
  // round trip (18 ticks here) after the fight began. Now it shows no later than the server's own start.
  assert.ok(shownAt <= serverFightAt + 1, `shown at tick ${shownAt}, server fight began at ${serverFightAt}`);
});

test('player() never hands out live references into the prediction state', () => {
  const h = harness({ latencyTicks: 3 });
  while (h.server.phase !== 'fight') h.tick(move(0, 0));
  for (let i = 0; i < 10; i++) h.tick(move(0, 0));
  const view = h.pred.player(h.server.players[0]);
  view.cd.dash = 99;
  assert.notEqual(h.pred.player(h.server.players[0]).cd.dash, 99);
});

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('pacer sends slower while the server queue is deep and faster when it runs dry', async () => {
  const { createPacer } = await import('../predict.js');
  const sent = (depth) => {
    const p = createPacer();
    for (let i = 0; i < 30; i++) p.observe(depth);
    let n = 0;
    for (let i = 0; i < 600; i++) n += p.due(C.DT, C.DT); // 10s of real time
    return n;
  };
  const steady = sent(1);
  assert.ok(Math.abs(steady - 600) <= 1, `at the target depth it sends at 60Hz, sent ${steady}`);
  assert.ok(sent(6) < 575, 'deep queue: at least 4% slower, so a backlog drains');
  assert.ok(sent(0) > 610, 'dry queue: faster, so the server stops starving');
  const p = createPacer();
  assert.equal(p.due(5, C.DT), 3, 'after a background tab it never bursts more than 3');
  assert.equal(p.due(C.DT, C.DT), 1);
});
