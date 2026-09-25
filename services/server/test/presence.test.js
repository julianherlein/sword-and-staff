import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createPresence, clientAddress, summarizeAgent, formatDuration, formatTime } from '../presence.js';
import { RoomManager } from '../rooms.js';
import { createServer } from '../index.js';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:129.0) Gecko/20100101 Firefox/129.0',
};

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('summarizeAgent names browser and OS, including browsers that also claim Chrome/Safari', () => {
  assert.equal(summarizeAgent(UA.chromeWin), 'Chrome/Windows');
  assert.equal(summarizeAgent(UA.edgeWin), 'Edge/Windows');
  assert.equal(summarizeAgent(UA.safariIphone), 'Safari/iOS');
  assert.equal(summarizeAgent(UA.chromeAndroid), 'Chrome/Android', 'Android UAs also say Linux');
  assert.equal(summarizeAgent(UA.firefoxMac), 'Firefox/macOS');
  assert.equal(summarizeAgent('node-ws'), 'other/other');
  assert.equal(summarizeAgent(undefined), 'unknown browser');
});

test('clientAddress: direct peers as-is, tunnel (loopback) peers by forwarded header', () => {
  assert.equal(clientAddress(req('::ffff:192.168.1.20')), '192.168.1.20');
  assert.equal(clientAddress(req('203.0.113.9')), '203.0.113.9');
  // cloudflared connects from localhost and says who the real client is.
  assert.equal(clientAddress(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(clientAddress(req('::1', { 'x-forwarded-for': '198.51.100.8, 10.0.0.1' })), '198.51.100.8');
  assert.equal(clientAddress(req('127.0.0.1')), '127.0.0.1', 'plain local connection');
  // A remote client cannot spoof its address with a header.
  assert.equal(clientAddress(req('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' })), '203.0.113.9');
  assert.equal(clientAddress(req(undefined)), 'unknown');
});

test('formatDuration and formatTime', () => {
  assert.equal(formatDuration(4400), '4s');
  assert.equal(formatDuration(109000), '1m49s');
  assert.equal(formatDuration(3 * 3600e3 + 5 * 60e3), '3h05m');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatTime(new Date(2026, 8, 24, 9, 3, 7).getTime()), '2026-09-24 09:03:07');
});

test('presence log: connect, lobby events, disconnect, with a live online count', () => {
  const lines = [];
  let t = new Date(2026, 8, 24, 20, 0, 0).getTime();
  const p = createPresence({ log: (l) => lines.push(l), now: () => t });
  const rooms = new RoomManager({ onEvent: (e) => p.room(e) });
  const join = (ip, ua) => {
    const id = p.connect(req(ip, { 'user-agent': ua }));
    const inbox = [];
    return { id, inbox, ...rooms.connect((m) => inbox.push(m), id) };
  };
  const a = join('203.0.113.9', UA.chromeWin);
  const b = join('198.51.100.7', UA.safariIphone);
  const c = join('192.0.2.1', UA.firefoxMac);
  const d = join('192.0.2.2', UA.edgeWin);
  a.message({ t: 'queue', cls: 'mage' });
  b.message({ t: 'queue', cls: 'warrior' });
  c.message({ t: 'create', cls: 'warrior' });
  const room = c.inbox.find((m) => m.t === 'created').code;
  d.message({ t: 'join', code: room, cls: 'mage' });
  t += 109000;
  p.disconnect(a.id);
  a.close();
  p.disconnect(a.id); // a second close must not log or miscount
  const out = lines.map((l) => l.slice(21)); // drop the timestamp and its gap
  assert.equal(lines[0].slice(0, 21), '2026-09-24 20:00:00  ');
  assert.deepEqual(out, [
    '+ #1 connected from 203.0.113.9 (Chrome/Windows)  online: 1',
    '+ #2 connected from 198.51.100.7 (Safari/iOS)  online: 2',
    '+ #3 connected from 192.0.2.1 (Firefox/macOS)  online: 3',
    '+ #4 connected from 192.0.2.2 (Edge/Windows)  online: 4',
    '  #1 queued as mage',
    out[5], // matched line, checked below (queue room code is random)
    `  #3 opened room ${room} as warrior`,
    `  #4 joined room ${room} as mage: #3 warrior vs #4 mage`,
    '- #1 disconnected after 1m49s  online: 3',
    '  #2 queued as warrior', // #1 left during "match found", so #2 went back in line
  ]);
  assert.match(out[5], /^ {2}matched #1 mage vs #2 warrior in room [A-Z0-9]{4}$/);
  assert.equal(p.online.size, 3);
});

test('presence log: opponent re-queued when a matched player drops during the countdown', () => {
  const lines = [];
  const p = createPresence({ log: (l) => lines.push(l.slice(21)), now: () => 0 });
  const rooms = new RoomManager({ onEvent: (e) => p.room(e) });
  const a = rooms.connect(() => {}, p.connect(req('192.0.2.1')));
  const b = rooms.connect(() => {}, p.connect(req('192.0.2.2')));
  a.message({ t: 'queue', cls: 'mage' });
  b.message({ t: 'queue', cls: 'warrior' });
  a.close();
  assert.equal(lines.at(-1), '  #2 queued as warrior');
});

test('server writes the connection log for real WebSocket clients, silent by default', async () => {
  const lines = [];
  const { server } = createServer({ matchFoundSecs: 0.1, log: (l) => lines.push(l) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const open = (headers) => new Promise((res, rej) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
  const sockets = [];
  const until = async (pred) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(pred(), `log never matched; got:\n${lines.join('\n')}`);
  };
  try {
    const a = await open({ 'user-agent': UA.chromeWin, 'cf-connecting-ip': '198.51.100.7' });
    const b = await open({ 'user-agent': UA.safariIphone });
    sockets.push(a, b);
    await until(() => lines.length === 2);
    assert.match(lines[0], /\+ #1 connected from 198\.51\.100\.7 \(Chrome\/Windows\) {2}online: 1$/, 'tunnel header trusted from loopback');
    assert.match(lines[1], /\+ #2 connected from 127\.0\.0\.1 \(Safari\/iOS\) {2}online: 2$/);
    a.send(JSON.stringify({ t: 'queue', cls: 'mage' }));
    await until(() => lines.some((l) => l.endsWith('#1 queued as mage')));
    b.send(JSON.stringify({ t: 'queue', cls: 'warrior' }));
    await until(() => lines.some((l) => /matched #1 mage vs #2 warrior in room \w{4}$/.test(l)));
    a.close();
    await until(() => lines.some((l) => /- #1 disconnected after \d+s {2}online: 1$/.test(l)));
  } finally {
    for (const ws of sockets) ws.terminate();
    await new Promise((r) => server.close(r));
  }

  // Default: no log option, nothing printed (the test run stays quiet).
  const quiet = createServer();
  assert.doesNotThrow(() => quiet.presence.connect(req('192.0.2.1')));
  quiet.server.close();
});
