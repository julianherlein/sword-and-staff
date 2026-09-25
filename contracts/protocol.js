// Shared contract between client, server, sim and bot.
// Every producer of player input goes through sanitizeInput before it reaches the sim.

export const PROTOCOL_VERSION = 2; // 2: input sequence numbers + acks for client-side prediction

// Bit positions of the held-button mask `b`.
export const BUTTONS = ['primary', 'secondary', 'dash', 'q', 'e', 'r'];
export const BUTTON_BIT = Object.fromEntries(BUTTONS.map((k, i) => [k, 1 << i]));
const ALL_BITS = (1 << BUTTONS.length) - 1;

// One tick of intent for one player.
//   mx,my  movement direction in world space, length <= 1
//   ax,ay  aim point in world coordinates (cursor on the ground)
//   b      held buttons bitmask (see BUTTON_BIT)
export function emptyInput() {
  return { mx: 0, my: 0, ax: 0, ay: 0, b: 0 };
}

const AIM_LIMIT = 100;

function num(v, lo, hi) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}

export function sanitizeInput(raw) {
  if (!raw || typeof raw !== 'object') return emptyInput();
  let mx = num(raw.mx, -1, 1);
  let my = num(raw.my, -1, 1);
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  return {
    mx, my,
    ax: num(raw.ax, -AIM_LIMIT, AIM_LIMIT),
    ay: num(raw.ay, -AIM_LIMIT, AIM_LIMIT),
    b: Number.isInteger(raw.b) ? raw.b & ALL_BITS : 0,
  };
}

export function held(input, key) {
  return (input.b & BUTTON_BIT[key]) !== 0;
}

// Network messages (JSON over WebSocket).
// client -> server: {t:'create', cls} | {t:'join', code, cls} | {t:'input', s:seq, i:Input} | {t:'rematch'}
//   seq: increasing integer per client; the server applies inputs one per tick in seq order.
// server -> client: {t:'created', code} | {t:'start', you, classes, seed}
//                   {t:'snap', s:Snapshot, ev:Event[], ack:[seq0, seq1], q:[depth0, depth1]}
//   ack = last seq applied per slot; q = inputs still queued per slot (clients pace sending by it)
//                   {t:'error', msg} | {t:'left'}
export const MSG = Object.freeze({
  CREATE: 'create', JOIN: 'join', INPUT: 'input', REMATCH: 'rematch',
  CREATED: 'created', START: 'start', SNAP: 'snap', ERROR: 'error', LEFT: 'left',
});

export const CLASS_IDS = ['warrior', 'mage'];

export function isRoomCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{4}$/.test(code);
}
