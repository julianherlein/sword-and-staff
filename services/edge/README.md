# edge

The online game server on Cloudflare, so matches run without your PC. It is the same server as
`services/server`, hosted differently: the same `RoomManager` (queue, room codes, 60Hz authoritative
sim, 30Hz snapshots), the same presence log, the same fixed-timestep ticker. The client does not
change: it connects to `/ws` on whatever host served the page.

```
browser ──https──► Cloudflare ──► Static Assets (dist/: client, sim, ai, contracts, three.js)   free, unmetered
browser ──wss /ws─► Cloudflare ──► Worker (src/worker.js) ──► Durable Object "lobby" (GameServer)
                                                                └─ hub.js: RoomManager + ticker
```

- **Worker** (`src/worker.js`): runs at the Cloudflare site nearest each player, keeps no state.
  Static files never reach it. It only handles `/ws` (426 without a WebSocket upgrade) and 404s.
- **Durable Object** `GameServer`: one instance worldwide (`idFromName('lobby')`), so every player
  reaches the same queue and room codes. State lives in memory only; nothing is stored. It uses
  `accept()`, not the Hibernation API, because a hibernated object would lose the running match.
- **`src/hub.js`**: the transport glue, pure apart from injected timers, so `test/hub.test.js`
  runs it in plain Node. The tick loop runs only while a socket is open; with nobody connected
  there is no timer and the object can be evicted, so an idle server costs nothing.
- **`build.mjs`**: copies into `dist/` exactly the files `services/server` would serve (same
  `PUBLIC` roots, same `resolvePublic` filter), so tests, server source and `.env` are never
  uploaded. It syncs in place because a running `wrangler dev` locks `dist/` on Windows.

## Commands (from the repo root)

```bash
npx wrangler login     # once per machine
npm run dev:edge       # the Cloudflare version locally on real workerd: http://127.0.0.1:8787
npm run deploy         # upload: https://iron-and-arcane.<your-subdomain>.workers.dev
npm run logs:edge      # live connection log from the deployed server (+ connect, - disconnect, matches)
npm run eval:edge -- https://iron-and-arcane.<your-subdomain>.workers.dev
```

Use the npm scripts, not bare `wrangler`: the `[build]` step runs `npm run build:edge`, and wrangler
starts builds from different directories depending on how it is launched.

`npm start` and `npm run share` are unchanged: the Node server is still the local and LAN option,
and `npm run share` has no quota.

## Free plan budget

Checked against Cloudflare's docs on 2026-09-24:

| Resource | Free plan | This game |
|---|---|---|
| Static asset requests | free, unlimited, not counted | page loads, vs CPU and Local play cost nothing |
| Durable Object requests | 100,000/day, incoming WebSocket messages count 1/20 | 2 players x 60 inputs/s = 21,600 per match-hour: **about 4.6 match-hours/day** |
| Durable Object duration | 13,000 GB-s/day, billed at 128MB while awake | about 461 GB-s per hour awake: about 28 hours/day, never the limit with one object |
| Storage | SQLite-backed objects only | nothing stored; `new_sqlite_classes` in `wrangler.toml` only picks the kind |

Past the daily quota, `/ws` fails until midnight UTC; the free plan never bills. On the $5/month
paid plan, 1M requests and 400,000 GB-s per month are included, then $0.15 per million requests.

The request count is the limit, and it is set by the client sending one message per input.
Batching several inputs per message would multiply the budget (2 per message: about 9 hours/day).
That is a protocol change (v4) and is not done here.

## Abuse limits (the quota is shared by everyone)

Every incoming message is metered, so one script with the public URL could otherwise spend the day's
quota in seconds and take `/ws` down for everybody until midnight UTC. `src/hub.js` enforces:

| Limit | Value | What happens |
|---|---|---|
| Messages per socket | sustained 75/s, bursts up to 180 (3s of inputs) | closed with 1008 |
| Frame type | text only (the client never sends binary) | closed with 1003 |
| Frame size | 4096 UTF-8 bytes, as on the Node server | closed with 1009 |
| Open sockets per IP | 4 | HTTP 429 before the upgrade |
| New sockets per IP | 12 per minute | HTTP 429 before the upgrade |

Real play (60 inputs/s, plus a backlog delivered at once after a network freeze of up to about 2.5s) never
hits them; `test/hub.test.js` checks that. Loopback addresses are exempt from the per-IP limits,
which only happens under `wrangler dev`.

What these do not stop: someone who plays within the limits from many addresses, or from one
address all day (4 sockets at 75/s is about 15 requests/s, so the quota is gone in about 2 hours).
The free quota is small by nature. If that happens, the fix is a Cloudflare rate-limiting rule in
the dashboard, or the paid plan.

The runtime receives a whole frame (up to its own 32 MiB limit) before our size check sees it, so a
huge frame is received once and then the socket is closed; it cannot be sent twice.

`CF-Connecting-IP` is overwritten by Cloudflare in production, so the IP in the log and in the
per-IP limits is real. Under `wrangler dev` nothing overwrites it and a local client can set it.

## Limits to know

- **One object, one location.** Every match runs in it, on one CPU thread. Fine for friends and
  dozens of matches; a public game would split into a lobby object plus one object per room,
  placed near its players.
- **Where it runs: `LOBBY_REGION` in `wrangler.toml`** (default `sam`, South America). An object
  is placed when it is first created and never moves, so the region is part of its name
  (`lobby-sam`): changing it and redeploying starts a new object in the new place. Values: `wnam`
  `enam` `sam` `weur` `eeur` `apac` `apac-ne` `apac-se` `oc` `afr` `me`, or remove it to place the
  object near whoever connects first. Hints are best effort: Cloudflare picks the data center
  closest to the region that can host Durable Objects, and only about 11% of its sites can.
  **From Argentina the nearest one is Miami** (where.durableobjects.live, 2026-09-25: a Worker in
  Buenos Aires creates its objects in MIA), so `sam` did not move anything: measured the same
  ~170ms round trip with and without it. No setting fixes that; it is where the hardware is.
- **Latency** is player to nearest Cloudflare site to the object. Every input pays it before the
  server applies it; your own character hides it through prediction, the opponent does not.
  Across continents the far player pays the distance, as with any single authoritative server.
- **An open socket keeps the object awake**, even an idle one in the menu (as on the Node server).
  Duration is billed for that time, but one object can stay awake all day within the free 28 hours.
- **No `--lag`** option here; use `npm start -- --lag 150` locally.
- A deploy restarts the object: matches in progress end (both players see the socket close).

## Tests and eval

- `test/hub.test.js`: loop lifecycle, a queued match on a fake clock (5s countdown, 30Hz snapshots
  of a 60Hz sim), input acks, close/error handling, the byte cap (multibyte text), binary frames,
  floods, legit play plus a stall burst never limited, per-IP limits, frames in flight after a
  close (no ghost in the queue), sockets that fail on send, the connection log.
- `test/build.test.js`: the upload set matches the Node server's, never includes private files,
  rebuilds sync in place.
- `test/worker.test.js`: end to end on real workerd via `unstable_startWorker`: static routes,
  private files 404, `/ws` 426, a private-room match with acked inputs, the queue with a drop
  during "match found".
- `evals/edge.mjs`: a real 20s two-client match against any running server. Frozen thresholds:
  matchmaking start 4.8-5.6s after found, sim clock 58.8-61.2 ticks/s, snapshot interval p95 at most
  50ms and max at most 250ms, mean server input queue at most 3, `left` within 1s, and three
  hostile clients, one after another (1MB binary frame, 5000 frames at once, 12KB multibyte text), each closed with
  the right code while the match keeps every threshold above.
  Measured locally on 2026-09-24 (Windows, under attack): workerd 59.99 ticks/s, snapshots p50
  33.1ms p95 46.7ms max 56.9ms. Before the frame limits, the binary attack alone dropped the sim to
  57 ticks/s with a 557ms snapshot gap. Node server baseline: 59.98 ticks/s, p95 46.9ms.
  Deployed, from Argentina (edge EZE, 2026-09-25): 8/8 pass, 59.97 ticks/s, snapshots p50 32.6ms
  p95 37.8ms, input -> ack p50 203ms without a hint and 202ms with `LOBBY_REGION = "sam"`.
  Split: player to edge Worker ~33ms round trip, player to Durable Object ~170ms (a `create` ->
  `created` message pair). The ~135ms difference is Buenos Aires to Miami; see "Where it runs".
  For players in South America, `npm run share` (the tunnel to a PC in the same country) should be
  the lower-latency option: its path is player to Buenos Aires edge to the host PC, no Miami. Not
  measured yet; `npm run eval:edge -- <trycloudflare link>` would settle it.
- `test/lobby.test.js`: region to object name and hint, a region change reaches a new object, a
  typo fails loudly.
