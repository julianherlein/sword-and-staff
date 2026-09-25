// Online client: sends inputs, buffers server snapshots and interpolates between them
// (used for the opponent; the local player is predicted, see services/sim/predict.js).
import { MSG } from '/contracts/protocol.js';

const INTERP_DELAY = 50; // ms behind the newest snapshot, smooths 30Hz updates
const PING_EVERY = 1000; // ms. One message per second: under 2% of the 60 inputs/s a match sends.
const PING_KEEP = 5; // ping shown = median of the last few round trips, so one spike does not jump

export class NetClient {
  constructor(handlers) {
    this.h = handlers; // {created, queued, found, start, error, left, events, snap?, chat?}
    this.buffer = []; // [{at, s}]
    this.ws = null;
    this.ping = null; // ms round trip, null until measured
    this.rtts = [];
    this.pingTimer = null;
    this.pingSent = new Map(); // id -> performance.now() when sent
    this.pingId = 0;
  }

  // Measures the round trip once a second while a match is on (from "match found" on). Idempotent.
  startPing() {
    if (this.pingTimer) return;
    const tick = () => {
      const id = ++this.pingId;
      this.pingSent.set(id, performance.now());
      for (const k of this.pingSent.keys()) if (k < id - PING_KEEP) this.pingSent.delete(k); // lost or very late
      this.send({ t: MSG.PING, id });
    };
    tick();
    this.pingTimer = setInterval(tick, PING_EVERY);
  }

  onPong(id) {
    const sent = this.pingSent.get(id);
    if (sent === undefined) return;
    this.pingSent.delete(id);
    this.rtts.push(performance.now() - sent);
    if (this.rtts.length > PING_KEEP) this.rtts.shift();
    const sorted = [...this.rtts].sort((a, b) => a - b);
    this.ping = sorted[sorted.length >> 1];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Cannot reach the game server. Start it with: npm start'));
      ws.onclose = () => this.h.left && this.h.left('Connection closed');
      ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  onMessage(m) {
    switch (m.t) {
      case MSG.CREATED: this.h.created(m.code); break;
      case MSG.QUEUED: this.h.queued(); break;
      case MSG.FOUND: this.startPing(); this.h.found(m); break;
      case MSG.START: this.startPing(); this.buffer = []; this.h.start(m); break;
      case MSG.PONG: this.onPong(m.id); break;
      case MSG.ERROR: this.h.error(m.msg); break;
      case MSG.LEFT: this.h.left('Opponent left the match'); break;
      case MSG.CHAT: if (this.h.chat) this.h.chat(m); break;
      case MSG.SNAP:
        this.buffer.push({ at: performance.now(), s: m.s });
        if (this.h.snap) this.h.snap(m);
        if (this.buffer.length > 30) this.buffer.shift();
        if (m.ev.length) this.h.events(m.ev, m.s);
        break;
      default:
    }
  }

  // Interpolated view for rendering: newest snapshot's discrete fields with lerped positions.
  view() {
    const b = this.buffer;
    if (!b.length) return null;
    const t = performance.now() - INTERP_DELAY;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].at > t) i--;
    const newest = b[b.length - 1].s;
    if (i === 0) return { view: newest, prev: null, alpha: 1 };
    const a = b[i - 1], c = b[i];
    const k = Math.max(0, Math.min(1, (t - a.at) / Math.max(1, c.at - a.at)));
    const view = structuredClone(c.s);
    view.players.forEach((p, j) => {
      const q = a.s.players[j];
      if (!q || !p.alive) return;
      p.x = q.x + (p.x - q.x) * k;
      p.y = q.y + (p.y - q.y) * k;
      p.z = (q.z || 0) + ((p.z || 0) - (q.z || 0)) * k;
    });
    const prevProj = new Map(a.s.projectiles.map((pr) => [pr.id, pr]));
    return { view, prevProj, alpha: k };
  }

  close() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.ws = null;
  }
}
