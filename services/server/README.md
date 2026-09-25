# server

`node services/server/index.js [--port 8080] [--lag 150]` serves the client and hosts online rooms.
`--lag` adds simulated round-trip latency to every WebSocket message (dev only).

- HTTP: serves only `services/client`, `services/sim`, `services/ai`, `contracts` and the three.js
  build. `test/` folders, the server source, `.env`, `.git` and path traversal are refused.
- Tick loop: `ticker.js` runs a fixed 60Hz timestep against the real clock. Plain `setInterval`
  fires every ~22ms on Windows, which ran online matches at 75% speed.
- WebSocket `/ws`: `rooms.js` (`RoomManager`) is transport-agnostic and fully tested without sockets.
  Two ways into a room (protocol v3):
  - Matchmaking: `{t:'queue', cls}`. One FIFO queue, no skill rating. With nobody waiting you get
    `{t:'queued'}` and wait; otherwise you are paired with the waiter (who takes slot 0). Both get
    `{t:'found', secs, you, classes}` and the match starts `MATCH_FOUND_SECS` (5) later, counted in
    server ticks. If one player drops during that countdown, the other goes straight back in the
    queue (`queued` again, or paired at once with whoever is waiting), never to the menu. Closing
    the socket leaves the queue.
  - Private room: the host creates a room and gets a 4-letter code, the guest joins with it, and
    the match starts at once. A room never pulls from the queue.
  Either way, the server
  steps the authoritative sim at 60Hz and broadcasts snapshots plus events at 30Hz. Client inputs
  pass through `sanitizeInput`, so a modified client cannot move faster or edit its HP.
  Inputs carry a sequence number (protocol v2). The server queues them per player and applies
  exactly one per tick in order. If none arrived (late packet), it repeats the last movement and
  aim but never the buttons, so no phantom casts. Snapshots carry `ack` (last seq applied per
  player) and `q` (queue depth per player). Clients pace their send rate from `q` so a backlog
  drains without dropping anything. As a backstop, a queue that stays above 3 for 0.5s drops its
  oldest input, and overflow beyond 6 drops too, with buttons always carried forward. Events are
  tagged with the seq their player had just applied (`e.seq`). Sequence numbers keep counting
  across rematches.
  Rematch starts when both players ask for it. A disconnect ends the room and tells the opponent.

Tests: `node --test services/server/test/` (includes a real WebSocket round trip).
