// Cloudflare entry point. Static files (the client, sim, three.js) are served by Workers Static
// Assets before this code runs, and do not count against the request quota. This Worker only sees
// what no asset matched: `/ws`, which it hands to the one GameServer Durable Object, and 404s.
import { DurableObject } from 'cloudflare:workers';
import { createHub } from './hub.js';

const isUpgrade = (request) => (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
    if (!isUpgrade(request)) return new Response('expected a WebSocket upgrade', { status: 426 });
    // One object for everybody: the matchmaking queue and room codes need a single global view.
    return env.GAME.get(env.GAME.idFromName('lobby')).fetch(request);
  },
};

// Exactly one instance exists worldwide (per name), so both players of a match reach the same
// RoomManager. State lives in memory only; nothing is written to the object's storage.
export class GameServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = createHub({ log: console.log });
  }

  async fetch(request) {
    if (!isUpgrade(request)) return new Response('expected a WebSocket upgrade', { status: 426 });
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const refused = this.hub.admit(ip);
    if (refused) return new Response(refused, { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept(); // not the Hibernation API: a hibernated object would lose the in-memory match
    this.hub.attach(server, { ip, agent: request.headers.get('User-Agent') || '' });
    return new Response(null, { status: 101, webSocket: client });
  }
}
