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
