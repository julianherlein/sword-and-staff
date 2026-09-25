// Online client: sends inputs, buffers server snapshots and interpolates between them
// (used for the opponent; the local player is predicted, see services/sim/predict.js).
import { MSG } from '/contracts/protocol.js';

const INTERP_DELAY = 50; // ms behind the newest snapshot, smooths 30Hz updates

export class NetClient {
  constructor(handlers) {
    this.h = handlers; // {created, start, error, left, events}
    this.buffer = []; // [{at, s}]
    this.ws = null;
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
      case MSG.START: this.buffer = []; this.h.start(m); break;
      case MSG.ERROR: this.h.error(m.msg); break;
      case MSG.LEFT: this.h.left('Opponent left the match'); break;
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
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.ws = null;
  }
}
