import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import WebSocket from 'ws';
import { RoomManager, MATCH_FOUND_SECS, CHAT_RATE } from '../rooms.js';
import { TICK_RATE } from '../../sim/constants.js';
import { createServer, resolvePublic } from '../index.js';
import { BUTTON_BIT, CHAT_MAX, sanitizeChat } from '../../../contracts/protocol.js';

const FOUND_TICKS = MATCH_FOUND_SECS * TICK_RATE;
const ticks = (rooms, n) => { for (let i = 0; i < n; i++) rooms.tick(); };

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

test('matchmaking: first player waits, second is paired, both see match found, then start 5s later', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'mage' });
  assert.ok(a.last('queued'));
  assert.equal(a.last('found'), undefined);
  assert.equal(rooms.rooms.size, 0, 'no room until a pair exists');
  b.message({ t: 'queue', cls: 'warrior' });
  assert.equal(b.last('queued'), undefined, 'second player never waits');
  for (const [c, you] of [[a, 0], [b, 1]]) {
    assert.deepEqual(c.last('found'), { t: 'found', secs: 5, you, classes: ['mage', 'warrior'] });
    assert.equal(c.last('start'), undefined, 'no start during the countdown');
  }
  ticks(rooms, FOUND_TICKS - 1);
  assert.equal(a.last('start'), undefined, 'still counting at 4.98s');
  assert.equal(a.last('snap'), undefined, 'no sim runs during the countdown');
  rooms.tick();
  assert.equal(a.last('start').you, 0, 'longest waiter gets slot 0');
  assert.equal(b.last('start').you, 1);
  assert.deepEqual(a.last('start').classes, ['mage', 'warrior']);
  assert.equal(a.last('start').seed, b.last('start').seed);
  assert.equal(rooms.waiting, null);
  assert.equal(rooms.rooms.size, 1);
});

test('matchmaking: queue is FIFO across several pairs', () => {
  const rooms = new RoomManager();
  const [a, b, c, d, e] = Array.from({ length: 5 }, () => fakeClient(rooms));
  for (const x of [a, b, c, d, e]) x.message({ t: 'queue', cls: 'warrior' });
  ticks(rooms, FOUND_TICKS);
  assert.equal(a.last('start').you, 0); assert.equal(b.last('start').you, 1);
  assert.equal(c.last('start').you, 0); assert.equal(d.last('start').you, 1);
  assert.equal(e.last('start'), undefined, 'odd one out keeps waiting');
  assert.ok(e.last('queued'));
  assert.equal(rooms.rooms.size, 2);
  // Paired players are in different rooms: inputs from one pair never reach the other.
  for (let i = 0; i < 200; i++) rooms.tick();
  const x0 = c.last('snap').s.players[0].x;
  a.message({ t: 'input', s: 1, i: { mx: 1, my: 0, ax: 0, ay: 0, b: 0 } });
  for (let i = 0; i < 10; i++) rooms.tick();
  assert.equal(c.last('snap').s.players[0].x, x0);
});

test('matchmaking: leaving the queue removes you, so nobody is paired with a ghost', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'mage' });
  a.close();
  assert.equal(rooms.waiting, null);
  b.message({ t: 'queue', cls: 'mage' });
  assert.ok(b.last('queued'));
  assert.equal(a.last('start'), undefined);
  assert.equal(b.last('start'), undefined);
});

test('matchmaking: rejects bad class, double queue, and queueing while in a room', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms), h = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'paladin' });
  assert.equal(a.last('error').msg, 'bad queue');
  assert.equal(rooms.waiting, null);
  a.message({ t: 'queue', cls: 'mage' });
  a.message({ t: 'queue', cls: 'mage' });
  assert.equal(a.inbox.filter((m) => m.t === 'error').length, 2, 'cannot match yourself');
  assert.equal(a.last('start'), undefined);
  // A queued player cannot also host or join; a host cannot also queue.
  a.message({ t: 'create', cls: 'mage' });
  assert.equal(a.last('error').msg, 'bad create');
  h.message({ t: 'create', cls: 'warrior' });
  a.message({ t: 'join', code: h.last('created').code, cls: 'mage' });
  assert.equal(a.last('error').msg, 'bad join');
  h.message({ t: 'queue', cls: 'warrior' });
  assert.equal(h.last('error').msg, 'bad queue');
  assert.ok(rooms.waiting, 'rejections did not knock the waiter out of the queue');
  b.message({ t: 'queue', cls: 'warrior' });
  assert.equal(a.last('found').you, 0);
  // Paired but not started yet: still cannot host, join, or queue again.
  a.message({ t: 'queue', cls: 'mage' });
  assert.equal(a.last('error').msg, 'bad queue');
  b.message({ t: 'create', cls: 'mage' });
  assert.equal(b.last('error').msg, 'bad create');
});

test('matchmaking and host-by-code work side by side', () => {
  const rooms = new RoomManager();
  const q1 = fakeClient(rooms), host = fakeClient(rooms), guest = fakeClient(rooms), q2 = fakeClient(rooms);
  q1.message({ t: 'queue', cls: 'mage' });
  host.message({ t: 'create', cls: 'warrior' });
  guest.message({ t: 'join', code: host.last('created').code, cls: 'mage' });
  assert.equal(guest.last('start').you, 1);
  assert.equal(q1.last('start'), undefined, 'a private room never pulls from the queue');
  q2.message({ t: 'queue', cls: 'warrior' });
  assert.deepEqual(q2.last('found').classes, ['mage', 'warrior']);
  assert.equal(guest.last('found'), undefined, 'host-by-code starts at once, no match-found screen');
  assert.equal(rooms.rooms.size, 2);
});

test('matchmaking: opponent leaving mid-match notifies and frees the room', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'mage' });
  b.message({ t: 'queue', cls: 'warrior' });
  ticks(rooms, FOUND_TICKS);
  b.close();
  assert.ok(a.last('left'));
  assert.equal(rooms.rooms.size, 0);
  const c = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'mage' }); // back in line after the opponent left
  c.message({ t: 'queue', cls: 'mage' });
  assert.equal(c.last('found').you, 1);
});

test('matchmaking: opponent dropping during match found puts you back in the queue', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms), c = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'mage' });
  b.message({ t: 'queue', cls: 'warrior' });
  ticks(rooms, FOUND_TICKS / 2);
  b.close();
  assert.equal(a.last('left'), undefined, 'not kicked to the menu');
  assert.equal(a.inbox.filter((m) => m.t === 'queued').length, 2, 'told it is searching again');
  assert.equal(rooms.rooms.size, 0);
  ticks(rooms, FOUND_TICKS);
  assert.equal(a.last('start'), undefined, 'the abandoned countdown never fires');
  c.message({ t: 'queue', cls: 'warrior' });
  assert.equal(a.last('found').you, 0);
  ticks(rooms, FOUND_TICKS);
  assert.deepEqual(c.last('start').classes, ['mage', 'warrior'], 'fresh full countdown, then start');
});

test('matchmaking: the partner of a dropped player is paired at once if someone else is waiting', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms), c = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'mage' });
  b.message({ t: 'queue', cls: 'warrior' });
  c.message({ t: 'queue', cls: 'mage' }); // waiting while a and b count down
  a.close();
  assert.equal(b.last('found').you, 1, 'b joins the waiting c, c hosts');
  assert.equal(c.last('found').you, 0);
  ticks(rooms, FOUND_TICKS);
  assert.deepEqual(b.last('start').classes, ['mage', 'warrior']);
});

test('matchmaking: matchFoundSecs 0 starts immediately', () => {
  const rooms = new RoomManager({ matchFoundSecs: 0 });
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'mage' });
  b.message({ t: 'queue', cls: 'mage' });
  assert.equal(a.last('found'), undefined);
  assert.equal(b.last('start').you, 1);
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

test('matchmaking end to end over real WebSockets', async () => {
  const { server } = createServer({ matchFoundSecs: 0.3 });
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
    // A quitter queues and disconnects first; the next two must be paired with each other.
    const quitter = await open();
    sockets.push(quitter.ws);
    quitter.ws.send(JSON.stringify({ t: 'queue', cls: 'mage' }));
    await waitFor(quitter.inbox, 'queued');
    quitter.ws.close();
    await new Promise((r) => quitter.ws.on('close', r));
    const a = await open(), b = await open();
    sockets.push(a.ws, b.ws);
    a.ws.send(JSON.stringify({ t: 'queue', cls: 'warrior' }));
    await waitFor(a.inbox, 'queued');
    b.ws.send(JSON.stringify({ t: 'queue', cls: 'mage' }));
    const [fa, fb] = await Promise.all([waitFor(a.inbox, 'found'), waitFor(b.inbox, 'found')]);
    assert.deepEqual([fa.you, fb.you, fa.secs], [0, 1, 0.3]);
    assert.equal(a.inbox.find((m) => m.t === 'start'), undefined, 'start waits for the countdown');
    const [sa, sb] = await Promise.all([waitFor(a.inbox, 'start'), waitFor(b.inbox, 'start')]);
    assert.deepEqual([sa.you, sb.you], [0, 1]);
    assert.deepEqual(sb.classes, ['warrior', 'mage']);
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

test('an oversized or malformed frame closes that socket and never crashes the server', async () => {
  // Regression: 'error' from ws had no listener, so one 1MB frame killed the process (npm start,
  // npm run share) for everybody.
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const open = () => new Promise((r) => { const ws = new WebSocket(url); ws.on('open', () => r(ws)); ws.on('error', () => {}); });
  try {
    const big = await open();
    const closed = new Promise((r) => big.on('close', r));
    big.send(Buffer.alloc(1024 * 1024));
    assert.equal(await closed, 1009);
    const bad = await open();
    const closedBad = new Promise((r) => bad.on('close', r));
    bad._socket.write(Buffer.from([0x8f, 0x00])); // reserved opcode: a protocol violation
    assert.equal(await closedBad, 1002);
    const ok = await open();
    const reply = new Promise((r) => ok.once('message', (d) => r(JSON.parse(d))));
    ok.send(JSON.stringify({ t: 'join', code: 'ZZZZ', cls: 'mage' }));
    assert.deepEqual(await reply, { t: 'error', msg: 'Room not found' }, 'still serving');
    ok.terminate();
  } finally {
    server.close();
  }
});

test('chat: a line reaches both players of the room, tagged with the sender slot', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms), outsider = fakeClient(rooms);
  a.message({ t: 'create', cls: 'mage' });
  a.message({ t: 'chat', text: 'anyone?' });
  assert.equal(a.last('chat'), undefined, 'no chat while alone in a room');
  b.message({ t: 'join', code: a.last('created').code, cls: 'warrior' });
  b.message({ t: 'chat', text: '  gl hf  ' });
  assert.deepEqual(a.last('chat'), { t: 'chat', from: 1, text: 'gl hf' });
  assert.deepEqual(b.last('chat'), { t: 'chat', from: 1, text: 'gl hf' }, 'echoed to the sender');
  outsider.message({ t: 'chat', text: 'hi' });
  assert.equal(a.inbox.filter((m) => m.t === 'chat').length, 1, 'clients outside the room cannot talk to it');
  for (const text of ['', '   ', 42, null, { x: 1 }]) b.message({ t: 'chat', text });
  assert.equal(a.inbox.filter((m) => m.t === 'chat').length, 1, 'blank or non-string lines are dropped');
});

test('chat: works from the match-found countdown on, not while queued', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'queue', cls: 'mage' });
  a.message({ t: 'chat', text: 'waiting' });
  assert.equal(a.last('chat'), undefined, 'nobody to talk to in the queue');
  b.message({ t: 'queue', cls: 'warrior' });
  a.message({ t: 'chat', text: 'hi' });
  assert.deepEqual(b.last('chat'), { t: 'chat', from: 0, text: 'hi' });
  b.close();
  a.message({ t: 'chat', text: 'still there?' });
  assert.equal(a.last('chat').text, 'hi', 'back in the queue, chat is off again');
});

test('chat: flooding is rate limited per client and recovers over time', () => {
  let now = 0;
  const rooms = new RoomManager({ now: () => now });
  const a = fakeClient(rooms), b = fakeClient(rooms);
  a.message({ t: 'create', cls: 'mage' });
  b.message({ t: 'join', code: a.last('created').code, cls: 'warrior' });
  for (let i = 0; i < CHAT_RATE.burst + 3; i++) a.message({ t: 'chat', text: `spam ${i}` });
  assert.equal(b.inbox.filter((m) => m.t === 'chat').length, CHAT_RATE.burst);
  assert.equal(a.last('error').msg, 'You are chatting too fast');
  b.message({ t: 'chat', text: 'unaffected' });
  assert.equal(a.last('chat').text, 'unaffected', 'the limit is per sender');
  now += CHAT_RATE.every;
  a.message({ t: 'chat', text: 'ok now' });
  assert.equal(b.last('chat').text, 'ok now');
});

test('sanitizeChat: one trimmed line, no control or bidi characters, capped length', () => {
  assert.equal(sanitizeChat('a\nb\r\n\tc'), 'a b c');
  assert.equal(sanitizeChat('x‮evil\u0000'), 'x evil');
  assert.equal(sanitizeChat('<b>hi</b>'), '<b>hi</b>', 'HTML is kept as text; the client never renders it');
  assert.equal(sanitizeChat('w'.repeat(500)).length, CHAT_MAX);
  assert.equal(Array.from(sanitizeChat('🙂'.repeat(500))).length, CHAT_MAX, 'counted by code point');
  assert.equal(sanitizeChat(' \u0007 '), '');
});

test('ping: answered at once with the same id, in or out of a room; bad ids are ignored', () => {
  const rooms = new RoomManager();
  const a = fakeClient(rooms);
  a.message({ t: 'ping', id: 7 });
  assert.deepEqual(a.last('pong'), { t: 'pong', id: 7 }, 'no room needed and no tick needed');
  for (const id of ['7', 1.5, null, undefined, { x: 1 }]) a.message({ t: 'ping', id });
  assert.equal(a.inbox.filter((m) => m.t === 'pong').length, 1);
});
