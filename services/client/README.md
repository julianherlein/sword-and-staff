# client

Browser client. Vanilla ES modules plus three.js through an import map, with no build step.

| File | Role |
|---|---|
| `js/main.js` | menu, sessions (vs CPU, local 2P, online, attract-mode demo), fixed-step loop, pause, end screen |
| `js/render/world.js` | renderer, isometric orthographic camera, lights, bloom, procedural arena textures |
| `js/render/models.js` | Warrior and Mage built from primitives, procedural animation |
| `js/render/vfx.js` | GPU particles, projectile and telegraph views, lightning, meteor, pooled lights, floating text |
| `js/hud.js` | player frames, ability bars with cooldown sweeps, overhead bars, banners, SVG icons |
| `js/input.js` | keyboard+mouse, second keyboard player, gamepad, all mapped to contract inputs |
| `js/audio.js` | synthesized WebAudio sound effects |
| `js/net.js` | WebSocket client with snapshot interpolation |

Local modes run the sim in the page at a fixed 60Hz and render between ticks with interpolation.
Big hits add hit-stop and screen shake, and the killing blow triggers slow motion. The dynamic
light pool has a fixed size and effect shaders compile at startup (`vfx.warmup`), so there are
no shader-compile hitches mid-fight.

`window.__duel` exposes the session, world and vfx for debugging and browser automation.
