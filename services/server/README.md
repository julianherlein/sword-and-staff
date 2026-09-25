# server

`node services/server/index.js [--port 8080] [--lag 150]` serves the client and hosts online rooms.
`--lag` adds simulated round-trip latency to every WebSocket message (dev only).

- HTTP: serves only `services/client`, `services/sim`, `services/ai`, `contracts` and the three.js
  build. `test/` folders, the server source, `.env`, `.git` and path traversal are refused.
- Tick loop: `ticker.js` runs a fixed 60Hz timestep against the real clock. Plain `setInterval`
  fires every ~22ms on Windows, which ran online matches at 75% speed.
- WebSocket `/ws`: `rooms.js` (`RoomManager`) is transport-agnostic and fully tested without sockets.
  The host creates a room and gets a 4-letter code, the guest joins with it, and the server
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
