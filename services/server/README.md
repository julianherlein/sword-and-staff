# server

`node services/server/index.js [--port 8080]` serves the client and hosts online rooms.

- HTTP: serves only `services/client`, `services/sim`, `services/ai`, `contracts` and the three.js
  build. `test/` folders, the server source, `.env`, `.git` and path traversal are refused.
- Tick loop: `ticker.js` runs a fixed 60Hz timestep against the real clock. Plain `setInterval`
  fires every ~22ms on Windows, which ran online matches at 75% speed.
- WebSocket `/ws`: `rooms.js` (`RoomManager`) is transport-agnostic and fully tested without sockets.
  The host creates a room and gets a 4-letter code, the guest joins with it, and the server
  steps the authoritative sim at 60Hz and broadcasts snapshots plus events at 30Hz. Client inputs
  pass through `sanitizeInput`, so a modified client cannot move faster or edit its HP.
  Rematch starts when both players ask for it. A disconnect ends the room and tells the opponent.

Tests: `node --test services/server/test/` (includes a real WebSocket round trip).
