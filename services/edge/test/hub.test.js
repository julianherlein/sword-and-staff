import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub, MAX_MESSAGE, RATE, PER_IP, messageBytes } from '../src/hub.js';
import { MATCH_FOUND_SECS } from '../../server/rooms.js';

// Stand-in for the runtime's server-side WebSocket: an EventTarget with send/close/readyState.
class FakeSocket extends EventTarget {
  constructor() { super(); this.readyState = 1; this.inbox = []; this.closed = null; this.throwOnSend = false; }
  send(data) { if (this.throwOnSend) throw new Error('socket gone'); this.inbox.push(JSON.parse(data)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; }
  msg(obj) { this.dispatchEvent(new MessageEvent('message', { data: typeof obj === 'string' ? obj : JSON.stringify(obj) })); }
  fire(type) { this.dispatchEvent(new Event(type)); }
  all(t) { return this.inbox.filter((m) => m.t === t); }
  last(t) { return this.all(t).at(-1); }
}

// Deterministic clock + interval timers: advance(ms) moves time in 4ms steps and fires every interval.
function fakeTimers() {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    clock: () => t,
    setInterval: (fn, ms) => { timers.set(nextId, { fn, ms }); return nextId++; },
    clearInterval: (id) => { timers.delete(id); },
    advance(ms) {
      for (let s = 0; s < ms; s += 4) {
        t += 4;
        for (const { fn } of [...timers.values()]) fn();
      }
    },
    get active() { return timers.size; },
  };
}

function setup(opts = {}) {
  const timers = fakeTimers();
  const lines = [];
  const hub = createHub({ log: (l) => lines.push(l), now: () => 0, ...timers, ...opts });
  const join = (meta) => { const ws = new FakeSocket(); hub.attach(ws, meta); return ws; };
  return { hub, timers, lines, join };
}

test('tick loop runs only while someone is connected, and restarts on reconnect', () => {
  const { hub, timers, join } = setup();
  assert.equal(hub.running, false);
  assert.equal(timers.active, 0);
  const a = join(), b = join();
  assert.equal(hub.running, true);
  assert.equal(timers.active, 1, 'one loop for every connection, not one each');
  a.fire('close');
  assert.equal(hub.running, true, 'b is still connected');
  b.fire('close');
  assert.equal(hub.running, false, 'empty server: no timer keeps the object awake');
  assert.equal(timers.active, 0);
  join();
  assert.equal(hub.running, true);
  assert.equal(hub.connections, 1);
});

test('queued match: found for both, start after the countdown, then 30Hz snapshots of a 60Hz sim', () => {
  const { timers, join } = setup();
  const a = join(), b = join();
  a.msg({ t: 'queue', cls: 'mage' });
  assert.ok(a.last('queued'));
  b.msg({ t: 'queue', cls: 'warrior' });
  assert.equal(a.last('found').you, 0);
  assert.equal(b.last('found').you, 1);
  timers.advance(MATCH_FOUND_SECS * 1000 - 50);
  assert.equal(a.last('start'), undefined, 'still counting down');
  timers.advance(100);
  assert.deepEqual(a.last('start').classes, ['mage', 'warrior']);
  const before = a.all('snap').length;
  timers.advance(1000);
  const snaps = a.all('snap');
  assert.ok(Math.abs(snaps.length - before - 30) <= 1, `~30 snapshots per second, got ${snaps.length - before}`);
  const span = snaps.at(-1).s.tick - snaps[before].s.tick;
  assert.ok(Math.abs(span - 58) <= 2, `sim advances 60 ticks per second, got ${span} over 29 intervals`);
});

test('inputs reach the sim and are acknowledged', () => {
  const { timers, join } = setup({ matchFoundSecs: 0 });
  const a = join(), b = join();
  a.msg({ t: 'queue', cls: 'mage' });
  b.msg({ t: 'queue', cls: 'warrior' });
  assert.ok(a.last('start'), 'matchFoundSecs 0 starts at once');
  for (let s = 1; s <= 3; s++) a.msg({ t: 'input', s, i: { mx: 1, my: 0, ax: 0, ay: 0, b: 0 } });
  timers.advance(200);
  assert.equal(a.last('snap').ack[0], 3);
});

test('close and error on one socket: disconnect logged once, opponent told once', () => {
  const { lines, join } = setup({ matchFoundSecs: 0 });
  const a = join(), b = join();
  a.msg({ t: 'create', cls: 'mage' });
  b.msg({ t: 'join', code: a.last('created').code, cls: 'warrior' });
  b.fire('error');
  b.fire('close');
  assert.equal(a.all('left').length, 1);
  assert.equal(lines.filter((l) => l.includes('- #2 disconnected')).length, 1);
});

test('oversized message closes the socket with 1009 and frees the player', () => {
  const { hub, join } = setup({ matchFoundSecs: 0 });
  const a = join(), b = join();
  a.msg({ t: 'create', cls: 'mage' });
  b.msg({ t: 'join', code: a.last('created').code, cls: 'warrior' });
  b.msg(JSON.stringify({ t: 'rematch', pad: 'x'.repeat(MAX_MESSAGE) }));
  assert.deepEqual(b.closed, { code: 1009, reason: 'message too big' });
  assert.ok(a.last('left'), 'opponent is not left waiting for a dead player');
  assert.equal(hub.connections, 1);
  b.msg({ t: 'queue', cls: 'mage' }); // was already in flight when we closed
  const c = join();
  c.msg({ t: 'queue', cls: 'warrior' });
  assert.ok(c.last('queued'), 'nobody is paired with the closed socket');
  const edge = JSON.stringify({ t: 'input', s: 1, i: {} });
  a.msg(edge + ' '.repeat(MAX_MESSAGE - edge.length)); // exactly at the cap: accepted
  assert.equal(a.closed, null);
});

test('bad JSON is ignored, the socket stays open', () => {
  const { hub } = setup();
  const ws = new FakeSocket();
  hub.attach(ws);
  ws.msg('{not json');
  ws.msg('null');
  assert.equal(ws.closed, null);
  assert.equal(ws.inbox.length, 0);
  ws.msg({ t: 'queue', cls: 'mage' });
  assert.ok(ws.last('queued'), 'still serving after the junk');
});

test('binary frames of any size close the socket (the client only sends text)', () => {
  // Regression: binary frames used to be dropped without closing, so a 16MB frame every 50ms from a
  // third client slowed everyone's match to 57 ticks/s on real workerd.
  const { hub, join } = setup({ matchFoundSecs: 0 });
  const a = join(), b = join();
  a.msg({ t: 'create', cls: 'mage' });
  b.msg({ t: 'join', code: a.last('created').code, cls: 'warrior' });
  b.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(8) }));
  assert.deepEqual(b.closed, { code: 1003, reason: 'text frames only' });
  assert.ok(a.last('left'));
  assert.equal(hub.connections, 1);
});

test('the size cap counts UTF-8 bytes, like the Node server', () => {
  // Regression: 4000 x "€" is 4000 characters but 12000 bytes, and used to pass the check.
  const { join } = setup();
  const wide = join();
  wide.msg(JSON.stringify({ t: 'x', pad: '€'.repeat(1400) })); // 1400 chars of 3 bytes: over 4096
  assert.deepEqual(wide.closed, { code: 1009, reason: 'message too big' });
  const narrow = join();
  narrow.msg(JSON.stringify({ t: 'x', pad: 'e'.repeat(1400) })); // same length in ASCII: fine
  assert.equal(narrow.closed, null);
  assert.equal(messageBytes('€'.repeat(1400)), 4200);
  assert.equal(messageBytes('abc'), 3);
});

test('a flooding client is closed after its burst; frames already in flight are ignored', () => {
  // Every incoming message is metered on the free plan, so a flood would spend everyone's quota.
  const { hub, timers, join } = setup({ matchFoundSecs: 0 });
  const a = join(), flood = join();
  a.msg({ t: 'queue', cls: 'mage' });
  flood.msg({ t: 'queue', cls: 'warrior' });
  for (let s = 1; s <= RATE.burst + 50; s++) flood.msg({ t: 'input', s, i: {} });
  assert.deepEqual(flood.closed, { code: 1008, reason: 'too many messages' });
  assert.equal(hub.connections, 1);
  assert.ok(a.last('left'), 'the flooder\'s opponent is freed');
  timers.advance(100);
  assert.equal(hub.connections, 1);
});

test('legit play is never rate limited: 60 inputs/s for a minute, plus a 2.5s stall delivered at once', () => {
  const { timers, join } = setup({ matchFoundSecs: 0 });
  const a = join(), b = join();
  a.msg({ t: 'queue', cls: 'mage' });
  b.msg({ t: 'queue', cls: 'warrior' });
  let s = 0;
  for (let sec = 0; sec < 60; sec++) {
    for (let i = 0; i < 60; i++) { a.msg({ t: 'input', s: ++s, i: {} }); timers.advance(16); }
    timers.advance(40);
  }
  timers.advance(2500); // network stall: nothing arrives...
  for (let i = 0; i < 150; i++) a.msg({ t: 'input', s: ++s, i: {} }); // ...then the backlog lands at once
  assert.equal(a.closed, null);
});

test('per-IP limits: 4 open sockets, 12 new ones per minute; loopback (wrangler dev) is exempt', () => {
  const { hub, timers } = setup();
  const ip = '198.51.100.7';
  const open = [];
  for (let i = 0; i < PER_IP.open; i++) {
    assert.equal(hub.admit(ip), null);
    const ws = new FakeSocket();
    hub.attach(ws, { ip });
    open.push(ws);
  }
  assert.match(hub.admit(ip), /too many connections/);
  assert.equal(hub.admit('198.51.100.8'), null, 'another address is unaffected');
  for (const ws of open) ws.fire('close');
  // Reconnect loop: each attempt closes at once, but the per-minute window still fills up.
  for (let i = PER_IP.open; i < PER_IP.perMinute; i++) {
    assert.equal(hub.admit(ip), null);
    const ws = new FakeSocket();
    hub.attach(ws, { ip });
    ws.fire('close');
  }
  assert.match(hub.admit(ip), /reconnecting too fast/);
  timers.advance(60000);
  assert.equal(hub.admit(ip), null, 'the window slides');
  for (let i = 0; i < 50; i++) assert.equal(hub.admit('127.0.0.1'), null);
});

test('a socket that is closing or throws on send never breaks the tick for the other player', () => {
  const { timers, join } = setup({ matchFoundSecs: 0 });
  const a = join(), b = join();
  a.msg({ t: 'queue', cls: 'mage' });
  b.msg({ t: 'queue', cls: 'warrior' });
  b.readyState = 2; // CLOSING: sends are skipped
  const got = b.inbox.length;
  timers.advance(100);
  assert.equal(b.inbox.length, got);
  b.readyState = 1;
  b.throwOnSend = true;
  const before = a.all('snap').length;
  assert.doesNotThrow(() => timers.advance(100));
  assert.ok(a.all('snap').length > before, 'a keeps receiving snapshots');
});

test('connection log uses the edge-provided IP and summarizes the browser', () => {
  const { lines, join } = setup();
  join({ ip: '203.0.113.9', agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' });
  join();
  assert.match(lines[0], /\+ #1 connected from 203\.0\.113\.9 \(Chrome\/Windows\)  online: 1/);
  assert.match(lines[1], /\+ #2 connected from unknown \(unknown browser\)  online: 2/);
});
