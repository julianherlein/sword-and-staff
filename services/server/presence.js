// Connection log: who is connected and what they are doing. Players are anonymous (the protocol has
// no names), so a player is a connection number plus IP and browser. Pure apart from the injected
// `log` and `now`, so tests drive it without sockets or clocks.

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

// "Chrome/Windows" from a User-Agent. Order matters: Edge and Opera also say Chrome, Chrome also says Safari.
export function summarizeAgent(ua) {
  if (typeof ua !== 'string' || !ua) return 'unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  return `${browser}/${os}`;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The client's IP. Forwarding headers are only trusted from a loopback peer: that is the cloudflared
// tunnel (`npm run share`), which sets CF-Connecting-IP. A direct LAN/internet client could forge them.
export function clientAddress(req) {
  const peer = req?.socket?.remoteAddress || '';
  const h = req?.headers || {};
  if (LOOPBACK.has(peer)) {
    const fwd = h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return peer.startsWith('::ffff:') ? peer.slice(7) : peer || 'unknown';
}

export function createPresence({ log = console.log, now = Date.now } = {}) {
  const online = new Map(); // id -> { ip, agent, since }
  let nextId = 1;
  const out = (mark, text) => log(`${formatTime(now())}  ${mark} ${text}`);
  const tag = (id) => `#${id}`;

  return {
    online,
    // A socket opened. Returns the connection id used in every later line.
    connect(req) {
      const id = nextId++;
      const who = { ip: clientAddress(req), agent: summarizeAgent(req?.headers?.['user-agent']), since: now() };
      online.set(id, who);
      out('+', `${tag(id)} connected from ${who.ip} (${who.agent})  online: ${online.size}`);
      return id;
    },
    disconnect(id) {
      const who = online.get(id);
      if (!who) return; // never logged twice
      online.delete(id);
      out('-', `${tag(id)} disconnected after ${formatDuration(now() - who.since)}  online: ${online.size}`);
    },
    // Lobby events from RoomManager's onEvent. Clients carry the id they were connected with.
    room(e) {
      const ids = (e.room?.clients || []).map((c) => (c ? tag(c.id) : '?'));
      const classes = e.room?.classes || [];
      switch (e.type) {
        case 'queue': return out(' ', `${tag(e.client.id)} queued as ${e.client.cls}`);
        case 'create': return out(' ', `${ids[0]} opened room ${e.room.code} as ${classes[0]}`);
        case 'join': return out(' ', `${ids[1]} joined room ${e.room.code} as ${classes[1]}: ${ids[0]} ${classes[0]} vs ${ids[1]} ${classes[1]}`);
        case 'match': return out(' ', `matched ${ids[0]} ${classes[0]} vs ${ids[1]} ${classes[1]} in room ${e.room.code}`);
        default:
      }
    },
  };
}
