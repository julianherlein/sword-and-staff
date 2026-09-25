# client

Browser client. Vanilla ES modules plus three.js through an import map, with no build step.

| File | Role |
|---|---|
| `js/main.js` | menu (incl. online Find match / searching timer / Match found countdown, Host, Join), sessions (vs CPU, local 2P, online, attract-mode demo), fixed-step loop, pause, end screen |
| `js/render/world.js` | renderer, isometric orthographic camera, lights, night env map (IBL), 4x MSAA post chain, bloom, procedural arena textures |
| `js/render/models.js` | Warrior and Mage built from primitives, procedural animation |
| `js/render/vfx.js` | GPU particles, projectile and telegraph views, lightning, meteor, pooled lights, floating text |
| `js/hud.js` | player frames, ability bars with cooldown sweeps, overhead bars, banners, SVG icons |
| `js/input.js` | keyboard+mouse, second keyboard player, gamepad, all mapped to contract inputs |
| `js/touch.js` | phones/tablets (`pointer: coarse`): floating joystick, 6 ability buttons (tap = aim at enemy, drag = aim, drag back = cancel), aim reticle; feeds the same contract input through `KeyboardMouse` |
| `js/audio.js` | synthesized WebAudio sound effects |
| `js/net.js` | WebSocket client with snapshot interpolation (used for the opponent) |

Online, `OnlineSession` runs `services/sim/predict.js` for the local player. A pacer (fed by the
server's queue depth) decides when to send. Each send samples input, predicts one tick, shows
any own cosmetic events, and sends `{s, i}`. Each snapshot reconciles, and each frame renders
the predicted player over the interpolated view. Server events go through
`predictor.serverEvents()`, which drops your own events that already played and shows any the
prediction missed.

Local modes run the sim in the page at a fixed 60Hz and render between ticks with interpolation.
Big hits add hit-stop and screen shake, and the killing blow triggers slow motion. The dynamic
light pool has a fixed size and effect shaders compile at startup (`vfx.warmup`), so there are
no shader-compile hitches mid-fight.

`window.__duel` exposes the session, world and vfx for debugging and browser automation.
