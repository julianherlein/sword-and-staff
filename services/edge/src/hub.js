// The game server as it runs inside the Durable Object: the same RoomManager, presence log and
// fixed-timestep ticker as the Node server (services/server/index.js), wired to standard
// WebSocket objects instead of the `ws` package. Pure apart from the injected timers, so tests
// drive it in plain Node with fake sockets and a fake clock.
import { RoomManager } from '../../server/rooms.js';
import { createPresence } from '../../server/presence.js';
import { createTicker } from '../../server/ticker.js';
import { TICK_RATE } from '../../sim/constants.js';

const OPEN = 1; // WebSocket.OPEN
const encoder = new TextEncoder();

// Same cap as the Node server's `maxPayload`, in bytes. The runtime has already buffered the whole
// frame when we see it (up to its own 32 MiB limit); closing stops the sender from doing it again.
export const MAX_MESSAGE = 4096;

// Why these limits exist: every incoming message is metered (20 messages = 1 request, 100,000
// requests a day on the free plan), so one script could spend the day's quota for everyone.
// Legit play sends 60 inputs/s; after a network stall TCP delivers the backlog in one burst.
// The bucket allows 3s of inputs in one burst on top of a sustained 75/s, then closes the socket (1008).
export const RATE = { perSecond: 75, burst: 180 };
// Per IP address: open sockets at once, and new sockets per minute (stops reconnect loops that
// would reset the bucket). A household behind one IP can still run several tabs.
export const PER_IP = { open: 4, perMinute: 12 };
const LOOPBACK = new Set(['127.0.0.1', '::1']);

export function messageBytes(s) {
  return s.length * 3 <= MAX_MESSAGE ? s.length : encoder.encode(s).length; // a char is 1-3 UTF-8 bytes
}

// Token bucket: `take()` is false once a client sends faster than perSecond beyond its burst.
export function createBucket({ perSecond, burst }, clock) {
  let tokens = burst;
  let last = clock();
  return {
    take() {
      const t = clock();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

// `meta`: { ip, agent } for the connection log and the per-IP limits. On Cloudflare the IP is
// CF-Connecting-IP, which the edge overwrites, so a client cannot forge it. Under `wrangler dev`
// nothing overwrites it: a local client can send its own.
export function createHub({ log = () => {}, now = Date.now, clock = () => performance.now(), setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval, pollMs = 4, matchFoundSecs, rate = RATE, perIp = PER_IP } = {}) {
  const presence = createPresence({ log, now });
  const rooms = new RoomManager({ matchFoundSecs, onEvent: (e) => presence.room(e) });
  const sockets = new Set();
  const openByIp = new Map(); // ip -> open sockets
  const recentByIp = new Map(); // ip -> connect times (clock ms) within the last minute
  let loop = null;

  // The tick loop runs only while someone is connected. With no timer and no socket left, the
  // runtime is free to evict the object, so an empty server costs nothing.
  function startLoop() {
    if (loop) return;
    const advance = createTicker(() => rooms.tick(), TICK_RATE, clock);
    loop = setInterval(advance, pollMs);
  }
  function stopLoop() {
    if (!loop) return;
    clearInterval(loop);
    loop = null;
  }

  // Call before accepting a socket. Returns null to accept, or the reason to refuse (HTTP 429).
  function admit(ip = 'unknown') {
    // Loopback only happens under `wrangler dev` (deployed, Cloudflare sets the real address), where
    // tests and evals open many sockets from one machine.
    if (LOOPBACK.has(ip)) return null;
    const t = clock();
    const recent = (recentByIp.get(ip) || []).filter((at) => t - at < 60000);
    if ((openByIp.get(ip) || 0) >= perIp.open) return 'too many connections from your address';
    if (recent.length >= perIp.perMinute) return 'reconnecting too fast, wait a minute';
    recent.push(t);
    recentByIp.set(ip, recent);
    return null;
  }

  function attach(ws, meta = {}) {
    const ip = meta.ip || 'unknown';
    const send = (obj) => {
      if (ws.readyState !== OPEN) return;
      try { ws.send(JSON.stringify(obj)); } catch { /* closed between the check and the send */ }
    };
    // presence.clientAddress trusts forwarding headers only from loopback, so pass the IP as the peer.
    const id = presence.connect({ socket: { remoteAddress: ip }, headers: { 'user-agent': meta.agent } });
    const conn = rooms.connect(send, id);
    const bucket = createBucket(rate, clock);
    sockets.add(ws);
    openByIp.set(ip, (openByIp.get(ip) || 0) + 1);
    startLoop();

    let gone = false;
    const finish = () => {
      if (gone) return; // close and error can both fire (presence and rooms also tolerate a repeat)
      gone = true;
      sockets.delete(ws);
      const open = openByIp.get(ip) - 1;
      if (open > 0) openByIp.set(ip, open); else openByIp.delete(ip);
      for (const [k, times] of recentByIp) if (!times.some((at) => clock() - at < 60000)) recentByIp.delete(k);
      presence.disconnect(id);
      conn.close();
      if (sockets.size === 0) stopLoop();
    };
    const reject = (code, reason) => {
      try { ws.close(code, reason); } catch { /* already closing */ }
      finish();
    };
    ws.addEventListener('message', (e) => {
      if (gone) return; // frames already in flight after we closed
      if (!bucket.take()) return reject(1008, 'too many messages');
      if (typeof e.data !== 'string') return reject(1003, 'text frames only'); // the client only sends JSON text
      if (messageBytes(e.data) > MAX_MESSAGE) return reject(1009, 'message too big');
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      conn.message(msg);
    });
    // Since compat date 2026-04-07 the runtime answers the client's close frame itself.
    ws.addEventListener('close', finish);
    ws.addEventListener('error', finish);
  }

  return {
    admit,
    attach,
    rooms,
    presence,
    get connections() { return sockets.size; },
    get running() { return loop !== null; },
  };
}
