// Shared contract between client, server, sim and bot.
// Every producer of player input goes through sanitizeInput before it reaches the sim.

export const PROTOCOL_VERSION = 5; // 2: input seq + acks for prediction; 3: matchmaking queue; 4: chat; 5: ping

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
// client -> server: {t:'create', cls} | {t:'join', code, cls} | {t:'queue', cls} | {t:'input', s:seq, i:Input} | {t:'rematch'}
//                   {t:'chat', text}: to both players in your room (see sanitizeChat)
//                   {t:'ping', id}: id = integer; the server answers {t:'pong', id} at once (round-trip time)
//   queue: matchmaking. Pairs with whoever is already waiting (FIFO, no skill rating), else waits.
//   Leaving the queue or cancelling a hosted room = closing the socket.
//   seq: increasing integer per client; the server applies inputs one per tick in seq order.
// server -> client: {t:'created', code} | {t:'queued'} | {t:'start', you, classes, seed}
//                   {t:'found', secs, you, classes}: queue paired you; 'start' follows in `secs` seconds.
//                     If the opponent drops before that, you are put back in the queue ({t:'queued'} again).
//                   {t:'snap', s:Snapshot, ev:Event[], ack:[seq0, seq1], q:[depth0, depth1]}
//   ack = last seq applied per slot; q = inputs still queued per slot (clients pace sending by it)
//                   {t:'chat', from:slot, text}: a chat line, echoed to the sender too, so both see one order
//                   {t:'pong', id}: answer to {t:'ping', id}
//                   {t:'error', msg} | {t:'left'}
export const MSG = Object.freeze({
  CREATE: 'create', JOIN: 'join', QUEUE: 'queue', INPUT: 'input', REMATCH: 'rematch', CHAT: 'chat', PING: 'ping',
  CREATED: 'created', QUEUED: 'queued', FOUND: 'found', START: 'start', SNAP: 'snap', ERROR: 'error', LEFT: 'left', PONG: 'pong',
});

export const CLASS_IDS = ['warrior', 'mage'];

export function isRoomCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{4}$/.test(code);
}

export const CHAT_MAX = 120; // characters per chat line

// Chat text as the server relays it: one line, no control characters, trimmed, at most CHAT_MAX
// characters. Returns '' for anything that is not a non-blank string.
export function sanitizeChat(text) {
  if (typeof text !== 'string') return '';
  // Control and bidi-override characters could fake line breaks or reverse the rendered text.
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, CHAT_MAX).join('').trim(); // by code point: never split an emoji
}
