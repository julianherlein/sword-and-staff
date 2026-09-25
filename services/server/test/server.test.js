import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import WebSocket from 'ws';
import { RoomManager } from '../rooms.js';
import { createServer, resolvePublic } from '../index.js';
import { BUTTON_BIT } from '../../../contracts/protocol.js';

function fakeClient(rooms) {
  const inbox = [];
  const conn = rooms.connect((m) => inbox.push(m));
  return { inbox, ...conn, last: (t) => [...inbox].reverse().find((m) => m.t === t) };
}

test('create, join, and both players receive start with their slot', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'create', cls: 'mage' });
  const code = a.last('created').code;
  assert.match(code, /^[A-Z0-9]{4}$/);
  b.message({ t: 'join', code: code.toLowerCase(), cls: 'warrior' });
  assert.equal(a.last('start').you, 0);
  assert.equal(b.last('start').you, 1);
  assert.deepEqual(b.last('start').classes, ['mage', 'warrior']);
});

test('join errors: unknown room, full room, bad class', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms), c = fakeClient(rooms);
  b.message({ t: 'join', code: 'ZZZZ', cls: 'mage' });
  assert.equal(b.last('error').msg, 'Room not found');
  a.message({ t: 'create', cls: 'mage' });
  const code = a.last('created').code;
  b.message({ t: 'join', code, cls: 'paladin' });
  assert.equal(b.last('error').msg, 'bad join');
  b.message({ t: 'join', code, cls: 'mage' });
  c.message({ t: 'join', code, cls: 'mage' });
  assert.equal(c.last('error').msg, 'Room is full');
});

test('server applies client inputs and streams snapshots with events', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'create', cls: 'mage' });
  b.message({ t: 'join', code: a.last('created').code, cls: 'warrior' });
  for (let i = 0; i < 200; i++) rooms.tick(); // through the countdown
  const x0 = a.last('snap').s.players[0].x;
  a.message({ t: 'input', i: { mx: 1, my: 0, ax: 0, ay: 0, b: BUTTON_BIT.primary } });
  for (let i = 0; i < 30; i++) rooms.tick();
  const snap = b.last('snap');
  assert.ok(snap.s.players[0].x > x0, 'host moved on the guest screen');
  assert.ok(b.inbox.filter((m) => m.t === 'snap').some((m) => m.ev.some((e) => e.type === 'cast')), 'events forwarded');
});

test('malicious input is sanitized, not trusted', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'create', cls: 'warrior' });
  b.message({ t: 'join', code: a.last('created').code, cls: 'warrior' });
  for (let i = 0; i < 200; i++) rooms.tick();
  const x0 = a.last('snap').s.players[0].x;
  a.message({ t: 'input', i: { mx: 1000, my: 0, ax: 'x', ay: {}, b: -1, hp: 99999 } });
  rooms.tick(); rooms.tick();
  const p = a.last('snap').s.players[0];
  assert.ok(p.x - x0 < 0.5, 'speed hack clamped');
  assert.ok(p.hp <= p.maxHp);
});

test('disconnect notifies the opponent and frees the room', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'create', cls: 'mage' });
  b.message({ t: 'join', code: a.last('created').code, cls: 'mage' });
  a.close();
  assert.ok(b.last('left'));
  assert.equal(rooms.rooms.size, 0);
});

test('rematch needs both players and only after the match ended', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'create', cls: 'mage' });
  b.message({ t: 'join', code: a.last('created').code, cls: 'mage' });
  const room = [...rooms.rooms.values()][0];
  a.message({ t: 'rematch' });
  assert.equal(a.inbox.filter((m) => m.t === 'start').length, 1, 'ignored mid-match');
  room.state.phase = 'matchEnd';
  a.message({ t: 'rematch' });
  assert.equal(a.inbox.filter((m) => m.t === 'start').length, 1, 'waits for both');
  b.message({ t: 'rematch' });
  assert.equal(a.inbox.filter((m) => m.t === 'start').length, 2);
});

test('static paths: only public trees are served', () => {
  assert.ok(resolvePublic('/').endsWith(path.join('services', 'client', 'index.html')));
  assert.ok(resolvePublic('/services/sim/index.js'));
  assert.ok(resolvePublic('/node_modules/three/build/three.module.js'));
  assert.equal(resolvePublic('/package.json'), null);
  assert.equal(resolvePublic('/services/client/../../.git/config'), null);
  assert.equal(resolvePublic('/services/%2e%2e/%2e%2e/.env'), null);
  assert.equal(resolvePublic('/services/sim/test/sim.test.js'), null);
  assert.equal(resolvePublic('/services/server/index.js'), null);
});

test('end to end over a real WebSocket', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const open = () => new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => res({ ws, inbox }));
    ws.on('error', rej);
  });
  const waitFor = async (inbox, t) => {
    for (let i = 0; i < 200; i++) {
      const m = inbox.find((x) => x.t === t);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${t}`);
  };
  const sockets = [];
  try {
    const a = await open(), b = await open();
    sockets.push(a.ws, b.ws);
    a.ws.send(JSON.stringify({ t: 'create', cls: 'warrior' }));
    const { code } = await waitFor(a.inbox, 'created');
    b.ws.send(JSON.stringify({ t: 'join', code, cls: 'mage' }));
    await waitFor(b.inbox, 'start');
    const snap = await waitFor(b.inbox, 'snap');
    assert.equal(snap.s.players.length, 2);
  } finally {
    for (const ws of sockets) ws.terminate();
    server.close();
  }
});

test('ticker keeps 60 ticks per second on a coarse timer (Windows ~22ms intervals)', async () => {
  const { createTicker } = await import('../ticker.js');
  let clock = 0;
  let ticks = 0;
  const advance = createTicker(() => ticks++, 60, () => clock);
  // Regression: one tick per 22ms callback ran the game at 45Hz (75% speed).
  while (clock < 1000) { clock += 22; advance(); }
  assert.ok(Math.abs(ticks - 60) <= 1, `ran ${ticks} ticks in ~1s`);
});

test('ticker drops the backlog after a long stall instead of fast-forwarding', async () => {
  const { createTicker } = await import('../ticker.js');
  let clock = 0;
  let ticks = 0;
  const advance = createTicker(() => ticks++, 60, () => clock);
  clock = 5000; // machine slept for 5s
  assert.equal(advance(), 5);
  clock += 17;
  assert.equal(advance(), 1, 'back to normal pace, no 300-tick burst');
});

test('real server delivers ~30 snapshots per second', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const open = () => new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => res({ ws, inbox }));
    ws.on('error', rej);
  });
  const sockets = [];
  try {
    const a = await open(), b = await open();
    sockets.push(a.ws, b.ws);
    a.ws.send(JSON.stringify({ t: 'create', cls: 'warrior' }));
    await new Promise((r) => setTimeout(r, 100));
    const code = a.inbox.find((m) => m.t === 'created').code;
    b.ws.send(JSON.stringify({ t: 'join', code, cls: 'mage' }));
    await new Promise((r) => setTimeout(r, 300));
    const n0 = b.inbox.length;
    await new Promise((r) => setTimeout(r, 1000));
    const rate = b.inbox.length - n0;
    assert.ok(rate >= 27 && rate <= 33, `${rate} snapshots/s`);
  } finally {
    for (const ws of sockets) ws.terminate(); // also on failure, or open sockets keep the run alive
    server.close();
  }
});

// ---------------------------------------------------------------- prediction support (protocol v2)

function fightingRoom() {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'create', cls: 'warrior' });
  b.message({ t: 'join', code: a.last('created').code, cls: 'mage' });
  const room = [...rooms.rooms.values()][0];
  while (room.state.phase !== 'fight') rooms.tick();
  return { rooms, a, b, room };
}

test('inputs arriving in a burst are applied one per tick, in order, and acked per player', () => {
  const { rooms, a, room } = fightingRoom();
  const x0 = room.state.players[0].x;
  for (let s = 1; s <= 3; s++) a.message({ t: 'input', s, i: { mx: 1, my: 0, ax: 0, ay: 0, b: 0 } });
  rooms.tick();
  assert.equal(room.acks[0], 1);
  rooms.tick();
  assert.equal(room.acks[0], 2);
  rooms.tick();
  assert.equal(room.acks[0], 3);
  const moved = room.state.players[0].x - x0;
  assert.ok(Math.abs(moved - 3 * 5.6 / 60) < 1e-9, `exactly three ticks of warrior movement, got ${moved}`);
  rooms.tick(); // repeats the last input; a snapshot goes out on one of these two ticks
  rooms.tick();
  assert.equal(a.last('snap').ack[0], 3, 'snapshot carries the ack');
  assert.equal(room.acks[1], 0, 'the other player is untouched');
});

test('queue overflow drops the oldest inputs but never loses a button tap', () => {
  const { rooms, a, room } = fightingRoom();
  a.message({ t: 'input', s: 1, i: { mx: 0, my: 0, ax: 0, ay: 0, b: BUTTON_BIT.dash } });
  for (let s = 2; s <= 10; s++) a.message({ t: 'input', s, i: { mx: 0, my: 0, ax: 0, ay: 0, b: 0 } });
  assert.ok(room.queues[0].length <= 6);
  const before = room.state.players[0].stats.casts;
  rooms.tick();
  assert.equal(room.state.players[0].stats.casts, before + 1, 'the dash tap from seq 1 still fired');
});

test('stale or duplicate sequence numbers are ignored', () => {
  const { a, room } = fightingRoom();
  a.message({ t: 'input', s: 5, i: { mx: 1, my: 0, ax: 0, ay: 0, b: 0 } });
  a.message({ t: 'input', s: 5, i: { mx: -1, my: 0, ax: 0, ay: 0, b: 0 } });
  a.message({ t: 'input', s: 3, i: { mx: -1, my: 0, ax: 0, ay: 0, b: 0 } });
  assert.equal(room.queues[0].length, 1);
});

test('client prediction matches the real server exactly through a laggy link', async () => {
  const { createPredictor } = await import('../../sim/predict.js');
  const rooms = new RoomManager();
  const LAG = 7; // ticks each way (~117ms)
  const wire = []; // [{at, deliver}]
  let now = 0;
  const later = (fn) => wire.push({ at: now + LAG, fn });
  let pred = null;
  let last = null;
  const a = rooms.connect((m) => later(() => {
    if (m.t === 'start') pred = createPredictor(m.you);
    if (m.t === 'snap') { pred.reconcile(m.s, m.ack[0]); last = m; }
  }));
  const b = rooms.connect(() => {});
  a.message({ t: 'create', cls: 'warrior' });
  // The created message is delayed; read the code straight from the manager.
  b.message({ t: 'join', code: [...rooms.rooms.keys()][0], cls: 'mage' });
  const pump = () => {
    now++;
    for (let i = wire.length - 1; i >= 0; i--) if (wire[i].at <= now) { wire[i].fn(); wire.splice(i, 1); }
    rooms.tick();
  };
  const send = (raw) => { const { msg } = pred.input(raw); later(() => a.message({ t: 'input', ...msg })); };
  for (let i = 0; i < 260; i++) { pump(); if (pred) send({ mx: 0, my: 0, ax: 0, ay: 0, b: 0 }); }
  for (let i = 0; i < 90; i++) { pump(); send({ mx: Math.cos(i / 15), my: Math.sin(i / 15), ax: 4, ay: 4, b: 0 }); }
  for (let i = 0; i < 40; i++) { pump(); send({ mx: 0, my: 0, ax: 4, ay: 4, b: 0 }); }
  const room = [...rooms.rooms.values()][0];
  assert.equal(room.state.phase, 'fight');
  const s = room.state.players[0], p = pred.predicted();
  assert.ok(Math.hypot(s.x - p.x, s.y - p.y) < 1e-6, `server (${s.x}, ${s.y}) vs predicted (${p.x}, ${p.y})`);
  assert.ok(last.ack[0] > 0);
});

test('after a rematch, inputs keep working when the client continues its sequence numbers', async () => {
  const { createPredictor } = await import('../../sim/predict.js');
  const { rooms, a, b, room } = fightingRoom();
  for (let s = 1; s <= 50; s++) { a.message({ t: 'input', s, i: { mx: 0, my: 0, ax: 0, ay: 0, b: 0 } }); rooms.tick(); }
  room.state.phase = 'matchEnd';
  a.message({ t: 'rematch' });
  b.message({ t: 'rematch' });
  while (room.state.phase !== 'fight') rooms.tick();
  // Regression: a fresh predictor restarting at seq 1 was dropped as stale for the whole rematch.
  const stale = createPredictor(0);
  a.message({ t: 'input', ...stale.input({ mx: 1, my: 0, ax: 0, ay: 0, b: 0 }).msg });
  assert.equal(room.queues[0].length, 0, 'seq 1 after 50 is rejected, which is why seq must continue');
  const pred = createPredictor(0, { startSeq: 50 });
  const x0 = room.state.players[0].x;
  a.message({ t: 'input', ...pred.input({ mx: 1, my: 0, ax: 0, ay: 0, b: 0 }).msg });
  rooms.tick();
  assert.ok(room.state.players[0].x > x0, 'continued sequence moves the player');
});

test('--lag delays messages by about the requested round trip', async () => {
  const { server } = createServer({ lagMs: 200 });
  await new Promise((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  try {
    await new Promise((r) => ws.on('open', r));
    // Fastest of three: the added delay is the floor; parallel test files can only add on top.
    let rtt = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const got = new Promise((r) => ws.once('message', r));
      ws.send(JSON.stringify({ t: 'join', code: 'ZZZZ', cls: 'mage' }));
      await got;
      rtt = Math.min(rtt, Date.now() - t0);
    }
    assert.ok(rtt >= 190 && rtt < 450, `round trip ${rtt}ms`);
  } finally {
    ws.terminate();
    server.close();
  }
});

test('a backlog from one late burst drains back to the target depth', async () => {
  const { rooms, a, room } = fightingRoom();
  let s = 0;
  const idle = { mx: 0, my: 0, ax: 0, ay: 0, b: 0 };
  for (let i = 0; i < 6; i++) a.message({ t: 'input', s: ++s, i: idle }); // TCP stall releases 6 at once
  const depths = [];
  for (let i = 0; i < 180; i++) { a.message({ t: 'input', s: ++s, i: idle }); rooms.tick(); depths.push(room.queues[0].length); }
  // Regression: one input in, one out per tick kept the queue at 5-6 (100ms extra lag) forever.
  assert.ok(depths.at(-1) <= 2, `depth after 3s: ${depths.at(-1)}`); // literal, not the constant under test
  assert.ok(Math.max(...depths.slice(0, 10)) >= 5, 'the burst really was queued first');
});

test('a late packet repeats movement and aim, but never re-presses buttons', () => {
  const { rooms, a, room } = fightingRoom();
  a.message({ t: 'input', s: 1, i: { mx: 1, my: 0, ax: 9, ay: 0, b: BUTTON_BIT.dash } });
  const casts0 = room.state.players[0].stats.casts;
  rooms.tick();
  for (let i = 0; i < 400; i++) rooms.tick(); // nothing else arrives for ~7s (dash cooldown is 6s)
  assert.equal(room.state.players[0].stats.casts, casts0 + 1, 'no phantom second dash');
  assert.deepEqual(room.inputs[0], { mx: 1, my: 0, ax: 9, ay: 0, b: 0 });
});
