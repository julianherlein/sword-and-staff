// Authoritative online rooms. Transport-agnostic: each player is a `send(obj)` function,
// so tests drive it without sockets. The server runs the same sim as the browser and
// clients only send inputs, so nobody can teleport or edit their HP.
import { createMatch, step, snapshot } from '../sim/index.js';
import { emptyInput, sanitizeInput, sanitizeChat, isRoomCode, MSG, CLASS_IDS } from '../../contracts/protocol.js';
import { TICK_RATE } from '../sim/constants.js';

const SNAPSHOT_EVERY = 2; // 60Hz sim, 30Hz snapshots
// Inputs are queued and applied one per tick, in order, so the server replays exactly what the
// client predicted. A burst beyond this depth drops the oldest inputs (their buttons carry over).
export const MAX_INPUT_QUEUE = 6;
// Client and server tick at the same rate, so a backlog from one late packet would never shrink on
// its own. Clients pace their sending from the depth in each snapshot (`q`, see createPacer). As a
// backstop for clients that do not, if the queue never dropped below QUEUE_TARGET for a whole
// window, skip one input (its buttons carry over).
export const QUEUE_TARGET = 3;
const DRAIN_WINDOW = 30; // ticks (0.5s)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// A queue pairing is announced ("match found") this long before the match starts.
export const MATCH_FOUND_SECS = 5;
// Chat flood limit per client: a burst of CHAT_RATE.burst lines, then one every CHAT_RATE.every ms.
// Lines over the limit are dropped and the sender is told why.
export const CHAT_RATE = { burst: 5, every: 1000 };

function dropOldest(q) {
  const dropped = q.shift();
  if (q.length) q[0].input.b |= dropped.input.b; // never lose a tap
}

function resetInputs(room) {
  room.inputs = [emptyInput(), emptyInput()];
  room.queues = [[], []];
  room.acks = [0, 0];
  room.minDepth = [Infinity, Infinity];
  room.depthTicks = [0, 0];
  room.lastSeq = room.lastSeq || [0, 0]; // sequence numbers keep counting across rematches
}

export class RoomManager {
  // `onEvent({ type, client?, room? })` reports lobby activity (queue, match, create, join) for the
  // connection log. It only observes; nothing it does changes the game.
  constructor({ random = Math.random, matchFoundSecs = MATCH_FOUND_SECS, onEvent = () => {}, now = Date.now } = {}) {
    this.rooms = new Map();
    this.now = now;
    this.random = random;
    this.matchFoundSecs = matchFoundSecs;
    this.onEvent = onEvent;
    // Matchmaking: one FIFO queue, no skill rating. Whoever queues while someone is waiting is
    // paired with them at once, so at most one client is ever waiting.
    this.waiting = null;
  }

  openRoom(host, cls) {
    const room = { code: this.newCode(), clients: [host, null], classes: [cls, null], state: null, pending: [], rematch: [false, false], startIn: 0 };
    resetInputs(room);
    host.room = room;
    host.slot = 0;
    this.rooms.set(room.code, room);
    return room;
  }

  seat(room, client, cls) {
    room.clients[1] = client;
    room.classes[1] = cls;
    client.room = room;
    client.slot = 1;
  }

  // Matchmaking entry: pair with the waiting client, or become the waiting client.
  enqueue(client, cls) {
    client.cls = cls;
    const other = this.waiting;
    if (!other) {
      this.waiting = client;
      client.send({ t: MSG.QUEUED });
      this.onEvent({ type: 'queue', client });
      return;
    }
    this.waiting = null;
    const room = this.openRoom(other, other.cls); // longest waiter hosts (slot 0)
    this.seat(room, client, cls);
    this.onEvent({ type: 'match', room });
    room.startIn = Math.round(this.matchFoundSecs * TICK_RATE); // counted down by tick()
    if (room.startIn <= 0) return this.start(room);
    room.clients.forEach((c, i) => c.send({ t: MSG.FOUND, secs: this.matchFoundSecs, you: i, classes: room.classes }));
  }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  // A client connection. Returns handlers the transport calls. `id` only labels it in the log.
  connect(send, id = null) {
    const client = { id, send, room: null, slot: -1, cls: null, chat: { tokens: CHAT_RATE.burst, at: this.now() } };
    return {
      message: (msg) => this.onMessage(client, msg),
      close: () => this.leave(client),
    };
  }

  onMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case MSG.CREATE: {
        if (client.room || this.waiting === client || !CLASS_IDS.includes(msg.cls)) return client.send({ t: MSG.ERROR, msg: 'bad create' });
        const room = this.openRoom(client, msg.cls);
        client.send({ t: MSG.CREATED, code: room.code });
        this.onEvent({ type: 'create', room });
        return;
      }
      case MSG.QUEUE: {
        if (client.room || this.waiting === client || !CLASS_IDS.includes(msg.cls)) return client.send({ t: MSG.ERROR, msg: 'bad queue' });
        this.enqueue(client, msg.cls);
        return;
      }
      case MSG.JOIN: {
        const code = typeof msg.code === 'string' ? msg.code.toUpperCase() : '';
        const room = isRoomCode(code) ? this.rooms.get(code) : null;
        if (client.room || this.waiting === client || !CLASS_IDS.includes(msg.cls)) return client.send({ t: MSG.ERROR, msg: 'bad join' });
        if (!room) return client.send({ t: MSG.ERROR, msg: 'Room not found' });
        if (room.clients[1]) return client.send({ t: MSG.ERROR, msg: 'Room is full' });
        this.seat(room, client, msg.cls);
        this.onEvent({ type: 'join', room });
        this.start(room);
        return;
      }
      case MSG.INPUT: {
        const room = client.room;
        if (!room) return;
        const slot = client.slot;
        const seq = Number.isInteger(msg.s) ? msg.s : room.lastSeq[slot] + 1;
        if (seq <= room.lastSeq[slot]) return; // duplicate or stale
        room.lastSeq[slot] = seq;
        const q = room.queues[slot];
        q.push({ seq, input: sanitizeInput(msg.i) });
        while (q.length > MAX_INPUT_QUEUE) dropOldest(q);
        return;
      }
      case MSG.REMATCH: {
        const room = client.room;
        if (!room || !room.state || room.state.phase !== 'matchEnd') return;
        room.rematch[client.slot] = true;
        if (room.rematch[0] && room.rematch[1]) this.start(room);
        return;
      }
      case MSG.CHAT: {
        // Only between the two players of a room: from "match found" through the end screen.
        const room = client.room;
        if (!room || !room.clients[0] || !room.clients[1]) return;
        const text = sanitizeChat(msg.text);
        if (!text) return;
        if (!this.takeChat(client)) return client.send({ t: MSG.ERROR, msg: 'You are chatting too fast' });
        for (const c of room.clients) c.send({ t: MSG.CHAT, from: client.slot, text });
        return;
      }
      default:
    }
  }

  // Token bucket for chat lines (CHAT_RATE).
  takeChat(client) {
    const b = client.chat;
    const t = this.now();
    b.tokens = Math.min(CHAT_RATE.burst, b.tokens + (t - b.at) / CHAT_RATE.every);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  start(room) {
    room.startIn = 0;
    const seed = Math.floor(this.random() * 1e9);
    room.state = createMatch({ classes: room.classes, seed });
    resetInputs(room);
    room.rematch = [false, false];
    room.pending = [];
    room.clients.forEach((c, i) => c.send({ t: MSG.START, you: i, classes: room.classes, seed }));
  }

  leave(client) {
    if (this.waiting === client) this.waiting = null;
    const room = client.room;
    if (!room) return;
    this.rooms.delete(room.code);
    const found = room.startIn > 0; // left during "match found": the other player goes back in line
    for (const c of room.clients) {
      if (!c || c === client) continue;
      c.room = null;
      if (found) this.enqueue(c, c.cls);
      else c.send({ t: MSG.LEFT });
    }
    client.room = null;
  }

  // Advance every running room by one sim tick.
  tick() {
    for (const room of this.rooms.values()) {
      if (room.startIn > 0 && --room.startIn === 0) this.start(room);
      if (!room.state) continue;
      for (let i = 0; i < 2; i++) {
        const q = room.queues[i];
        room.minDepth[i] = Math.min(room.minDepth[i], q.length);
        if (++room.depthTicks[i] >= DRAIN_WINDOW) {
          if (room.minDepth[i] > QUEUE_TARGET) dropOldest(q);
          room.minDepth[i] = Infinity;
          room.depthTicks[i] = 0;
        }
        const next = q.shift();
        if (next) {
          room.inputs[i] = next.input;
          room.acks[i] = next.seq;
        } else {
          // Late packet: keep moving and aiming the same way, but never re-press buttons.
          // The client did not predict this extra tick, so a repeated tap would be a phantom cast.
          room.inputs[i] = { ...room.inputs[i], b: 0 };
        }
      }
      step(room.state, room.inputs);
      // Tag each event with the input seq its player had just applied, so a predicting client can
      // match its own events exactly, however long the network stalled.
      for (const e of room.state.events) if (e.id === 0 || e.id === 1) e.seq = room.acks[e.id];
      room.pending.push(...room.state.events);
      if (room.state.tick % SNAPSHOT_EVERY === 0) {
        const msg = { t: MSG.SNAP, s: snapshot(room.state), ev: room.pending, ack: room.acks.slice(), q: room.queues.map((q) => q.length) };
        room.pending = [];
        for (const c of room.clients) c.send(msg);
      }
    }
  }
}
