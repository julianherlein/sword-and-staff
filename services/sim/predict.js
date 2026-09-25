// Client-side prediction for online play.
//
// The sim is deterministic and shared, so instead of approximating movement the client replays its
// own unacknowledged inputs through the real `step()`, starting from the last server state:
//
//   every client tick   input(raw)          -> step the prediction forward, remember the input
//   every snapshot      reconcile(snap,ack) -> rebuild from the server, drop acked inputs, replay the rest
//   every frame         player(serverP)     -> own player for rendering: predicted + smoothed correction
//
// Only the local player is predicted. Damage, projectiles, zones and the opponent stay
// server-authoritative (the opponent is interpolated elsewhere). In the prediction state both
// players are invulnerable and hazards are removed, so a replay can never "kill" anyone.
import { step, copyPlayer, CLASSES, constants as C } from './index.js';
import { sanitizeInput, emptyInput } from '../../contracts/protocol.js';

// Fields of the local player taken from the prediction; everything else (hp, statuses) is the server's.
const PREDICTED = ['x', 'y', 'z', 'facing', 'vx', 'vy', 'kx', 'ky', 'cast', 'dash', 'leap', 'parry',
  'cd', 'mana', 'moving', 'combo', 'comboT', 'berserk'];

// Player-centric events worth showing immediately (animation, sound). Each is shown exactly once:
// from the prediction when it gets there first, otherwise from the server (see claim()).
export const COSMETIC_EVENTS = new Set(['cast', 'swing', 'dash', 'blink', 'leap', 'parryStart', 'berserk', 'nova']);

const MAX_PENDING = 180; // 3s of inputs; beyond that the server is not acking and we stop growing
const SNAP_DISTANCE = 3; // corrections larger than this (round reset, big knockback) snap instantly
// Own cosmetic events are matched by (type, ability) and the input seq that produced them: the server
// tags each event with the seq it had just applied, we tag ours with the seq we stepped. When the
// server runs dry during a network stall it keeps ticking without new inputs, so cooldowns end a few
// seqs earlier on the server than we predicted: the drift is bounded by the stall, not zero. The same
// ability cannot genuinely fire twice within its cooldown, so the window is a fraction of it.
const WINDOW_OF_COOLDOWN = 0.7;
// A shown event the server has not confirmed this many inputs after applying it was rejected.
const REJECT_AFTER = 20;
const ABILITY_OF_EVENT = { dash: 'dash', blink: 'dash', leap: 'e', parryStart: 'q', berserk: 'r', nova: 'e' };

const eventKey = (e) => `${e.type}:${e.ability || ''}`;

function eventWindow(cls, e) {
  const ab = CLASSES[cls] && CLASSES[cls].abilities[e.ability || ABILITY_OF_EVENT[e.type]];
  return ab ? Math.max(4, Math.floor(ab.cooldown * C.TICK_RATE * WINDOW_OF_COOLDOWN)) : 4;
}

// `startSeq`: sequence numbers must keep increasing across rematches on the same connection,
// because the server drops any seq it has already seen.
export function createPredictor(slot, { smoothing = 14, startSeq = 0 } = {}) {
  let seq = startSeq;
  let pending = []; // [{seq, input}] sent but not yet acknowledged
  let pred = null; // prediction state (full sim state)
  let serverPhase = 'countdown';
  let played = []; // own cosmetic events already shown: [{key, seq}]
  const offset = { x: 0, y: 0 }; // visual correction still being smoothed out
  const stats = { corrections: 0, snaps: 0, lastError: 0, eventsPredicted: 0, eventsLate: 0 };

  // Predict through the countdown too, so the first swing after "FIGHT!" is instant as well.
  let cls = null;
  let lastAck = 0;
  const clsOf = () => cls;
  const running = () => pred && (serverPhase === 'fight' || serverPhase === 'countdown');
  const active = () => running() && pred.phase === 'fight';

  function forward(input) {
    const ins = slot === 0 ? [input, emptyInput()] : [emptyInput(), input];
    step(pred, ins);
    return pred.events;
  }

  // Show each own cosmetic event once, whether it first appears in a forward step, a replay, or
  // (if we never predicted it) the server's stream.
  // `fromServer`: the server's own copy; it confirms a matching prediction instead of playing again.
  function claim(events, at, out, fromServer = false) {
    for (const e of events) {
      if (e.id !== slot || !COSMETIC_EVENTS.has(e.type)) continue;
      const key = eventKey(e);
      const win = eventWindow(clsOf(), e);
      const match = played.find((p) => p.key === key && Math.abs(p.seq - at) <= win && !(fromServer && p.confirmed));
      if (match) { if (fromServer) match.confirmed = true; continue; }
      played.push({ key, seq: at, confirmed: fromServer });
      out.push(e);
    }
    if (played.length > 64) played = played.filter((p) => p.seq > at - 1500); // longest cooldown is 20s
    return out;
  }

  // A cast we showed but the server refused (we were stunned and could not know yet): the server
  // applied that input a while ago and never sent a matching event. Forget it, so the real cast
  // later is shown instead of being mistaken for the one already played. Runs on the next snapshot,
  // after the previous message's events were matched.
  function forgetRejected(ack) {
    played = played.filter((p) => p.confirmed || p.seq + REJECT_AFTER > ack);
  }

  function rebuild(snap) {
    return {
      tick: snap.tick, t: 0, seed: 0,
      phase: snap.phase, phaseTime: snap.phaseTime, fightTime: snap.fightTime,
      round: snap.round, score: snap.score.slice(), winsNeeded: snap.winsNeeded, winner: -1, roundWinner: -1,
      players: snap.players.map((p) => ({ ...copyPlayer(p), hp: Infinity, maxHp: Infinity })),
      projectiles: [], zones: [],
      orb: { active: false, respawnAt: Infinity },
      ringRadius: C.ARENA_RADIUS,
      rounds: [], events: [], nextId: 1e9,
    };
  }

  return {
    stats,
    get pending() { return pending.length; },
    get seq() { return seq; },

    // Once per client tick. Returns {msg, events}: the message to send and cosmetic events to show now.
    input(raw) {
      const input = sanitizeInput(raw);
      seq += 1;
      pending.push({ seq, input });
      if (pending.length > MAX_PENDING) pending.shift();
      const events = [];
      if (running()) {
        claim(forward(input), seq, events);
        stats.eventsPredicted += events.length;
      }
      return { msg: { s: seq, i: input }, events };
    },

    // On every server snapshot. `ack` is the last input seq the server applied for this slot.
    // Returns own cosmetic events that surfaced only during the replay (rare), to show now.
    reconcile(snap, ack) {
      serverPhase = snap.phase;
      const before = active() ? { x: pred.players[slot].x + offset.x, y: pred.players[slot].y + offset.y } : null;
      forgetRejected(lastAck);
      if (Number.isInteger(ack)) { pending = pending.filter((p) => p.seq > ack); lastAck = ack; }
      pred = rebuild(snap);
      cls = snap.players[slot].cls;
      const events = [];
      if (!running()) { offset.x = offset.y = 0; return events; }
      for (const p of pending) claim(forward(p.input), p.seq, events);
      const me = pred.players[slot];
      if (!before || pred.phase !== 'fight') { offset.x = offset.y = 0; return events; }
      const ex = before.x - me.x, ey = before.y - me.y;
      const err = Math.hypot(ex, ey);
      stats.lastError = err;
      if (err > SNAP_DISTANCE || !me.alive) { offset.x = offset.y = 0; stats.snaps += 1; return events; }
      if (err > 1e-4) stats.corrections += 1;
      offset.x = ex;
      offset.y = ey;
      return events;
    },

    // Server events from a snapshot: returns the ones to show. Our own cosmetic events are dropped if
    // we already showed them, and shown (late) if the prediction missed them. Matching uses the seq
    // the server tagged on each event.
    serverEvents(evs) {
      const out = [];
      for (const e of evs) {
        if (e.id === slot && COSMETIC_EVENTS.has(e.type)) {
          const before = out.length;
          claim([e], Number.isInteger(e.seq) ? e.seq : -Infinity, out, true);
          stats.eventsLate += out.length - before;
        } else {
          out.push(e);
        }
      }
      return out;
    },

    // Once per rendered frame: decay the visual correction.
    update(dt) {
      const k = Math.exp(-smoothing * dt);
      offset.x *= k;
      offset.y *= k;
    },

    // The local player to render/HUD: server player with predicted fields overlaid.
    // Returns fresh objects so nothing downstream can hold a live reference into the prediction.
    player(serverPlayer) {
      if (!active() || !serverPlayer) return serverPlayer;
      const me = copyPlayer(pred.players[slot]);
      const out = { ...serverPlayer };
      for (const k of PREDICTED) out[k] = me[k];
      out.x += offset.x;
      out.y += offset.y;
      return out;
    },

    // Raw predicted position (no smoothing), for tests and evals.
    predicted() {
      return active() ? { x: pred.players[slot].x, y: pred.players[slot].y } : null;
    },
  };
}

// Input pacing: the server applies exactly one input per tick, so any queue backlog it builds up
// (after a network stall) is extra latency for everyone watching you. Rather than dropping inputs,
// which causes mispredictions, the client sends a few percent slower while the server reports a deep
// queue and a little faster when it runs dry, like Overwatch's time dilation.
// `target` is the depth reported after the server consumed this tick's input.
export function createPacer({ target = 1.0, gain = 0.06, min = 0.94, max = 1.1 } = {}) {
  let depth = target;
  let factor = 1;
  let acc = 0;
  return {
    get factor() { return factor; },
    // Server-reported queue depth for this player (from each snapshot).
    observe(d) {
      if (!Number.isFinite(d)) return;
      depth += (d - depth) * 0.2;
      factor = Math.min(max, Math.max(min, 1 + gain * (depth - target)));
    },
    // How many inputs to send after `dt` seconds of real time (normally 0 or 1, at most 3).
    due(dt, tickSeconds) {
      acc += dt;
      const interval = tickSeconds * factor;
      let n = 0;
      while (acc >= interval && n < 3) { acc -= interval; n++; }
      if (acc > interval) acc = 0; // tab was in the background: do not burst
      return n;
    },
  };
}
