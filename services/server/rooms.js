// Authoritative online rooms. Transport-agnostic: each player is a `send(obj)` function,
// so tests drive it without sockets. The server runs the same sim as the browser and
// clients only send inputs, so nobody can teleport or edit their HP.
import { createMatch, step, snapshot } from '../sim/index.js';
import { emptyInput, sanitizeInput, isRoomCode, MSG, CLASS_IDS } from '../../contracts/protocol.js';

const SNAPSHOT_EVERY = 2; // 60Hz sim, 30Hz snapshots
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  constructor({ random = Math.random } = {}) {
    this.rooms = new Map();
    this.random = random;
  }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  // A client connection. Returns handlers the transport calls.
  connect(send) {
    const client = { send, room: null, slot: -1 };
    return {
      message: (msg) => this.onMessage(client, msg),
      close: () => this.leave(client),
    };
  }

  onMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case MSG.CREATE: {
        if (client.room || !CLASS_IDS.includes(msg.cls)) return client.send({ t: MSG.ERROR, msg: 'bad create' });
        const code = this.newCode();
        const room = { code, clients: [client, null], classes: [msg.cls, null], inputs: [emptyInput(), emptyInput()], state: null, pending: [], rematch: [false, false] };
        client.room = room;
        client.slot = 0;
        this.rooms.set(code, room);
        client.send({ t: MSG.CREATED, code });
        return;
      }
      case MSG.JOIN: {
        const code = typeof msg.code === 'string' ? msg.code.toUpperCase() : '';
        const room = isRoomCode(code) ? this.rooms.get(code) : null;
        if (client.room || !CLASS_IDS.includes(msg.cls)) return client.send({ t: MSG.ERROR, msg: 'bad join' });
        if (!room) return client.send({ t: MSG.ERROR, msg: 'Room not found' });
        if (room.clients[1]) return client.send({ t: MSG.ERROR, msg: 'Room is full' });
        room.clients[1] = client;
        room.classes[1] = msg.cls;
        client.room = room;
        client.slot = 1;
        this.start(room);
        return;
      }
      case MSG.INPUT: {
        if (client.room) client.room.inputs[client.slot] = sanitizeInput(msg.i);
        return;
      }
      case MSG.REMATCH: {
        const room = client.room;
        if (!room || !room.state || room.state.phase !== 'matchEnd') return;
        room.rematch[client.slot] = true;
        if (room.rematch[0] && room.rematch[1]) this.start(room);
        return;
      }
      default:
    }
  }

  start(room) {
    const seed = Math.floor(this.random() * 1e9);
    room.state = createMatch({ classes: room.classes, seed });
    room.inputs = [emptyInput(), emptyInput()];
    room.rematch = [false, false];
    room.pending = [];
    room.clients.forEach((c, i) => c.send({ t: MSG.START, you: i, classes: room.classes, seed }));
  }

  leave(client) {
    const room = client.room;
    if (!room) return;
    this.rooms.delete(room.code);
    for (const c of room.clients) {
      if (c && c !== client) { c.send({ t: MSG.LEFT }); c.room = null; }
    }
    client.room = null;
  }

  // Advance every running room by one sim tick.
  tick() {
    for (const room of this.rooms.values()) {
      if (!room.state) continue;
      step(room.state, room.inputs);
      room.pending.push(...room.state.events);
      if (room.state.tick % SNAPSHOT_EVERY === 0) {
        const msg = { t: MSG.SNAP, s: snapshot(room.state), ev: room.pending };
        room.pending = [];
        for (const c of room.clients) c.send(msg);
      }
    }
  }
}
