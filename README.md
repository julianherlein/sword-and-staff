# Iron & Arcane: 1v1 Arena Duel

An isometric, medieval 1v1 arena brawler. **Argentum Online's** Warrior vs Mage duel (health, mana,
sword against spells) played at **Battlerite's** pace: free movement, mouse-aimed skillshots,
telegraphed ground spells you land by predicting where the enemy will be, short cooldowns,
a health orb in the middle and a ring of fire that closes in.

Three.js renders it in 3D (orthographic isometric camera, shadows, bloom, GPU particles, dynamic
lights). All sounds are synthesized in the browser, so there are no asset files.

## Play

```bash
npm install
npm start            # http://localhost:8080   (PORT=xxxx or --port xxxx to change)
```

Modes:

| Mode | What it is |
|---|---|
| **vs CPU** | Duel a bot: easy, normal or hard. The bot plays with the same inputs and cooldowns as you. |
| **Local** | Two players on one screen. P1 uses keyboard + mouse, P2 uses a gamepad or the right side of the keyboard. |
| **Online** | One player hosts and gets a 4-letter room code, the other joins. The server runs the match, so clients cannot cheat. For play over a LAN, use the address `npm start` prints under "on your network". |

First to 3 rounds wins.

### Playing with friends over the internet

```bash
npm run share        # game server + Cloudflare quick tunnel
```

The command prints `READY` and a public `https://<random>.trycloudflare.com` link once the link
actually answers (usually 10-40s). Send that link to your friend. You both open it, pick
**Online**, one hosts and the other joins with the room code. It needs no account and no router
setup, and the link stays up until you press Ctrl+C. You get a new link every run.

It needs `cloudflared` installed (`winget install --id Cloudflare.cloudflared` on Windows,
`brew install cloudflared` on macOS). The script finds it on PATH or in its default install
folder, or you can set `CLOUDFLARED=<path>`.

Online play has no client-side prediction yet, so your own movement shows up one round trip late.
That feels fine at LAN or same-country latency and sluggish above about 120ms.

## Controls

| Action | Player 1 (KB + mouse) | Player 2 (keyboard) | Gamepad |
|---|---|---|---|
| Move | `W A S D` | Arrows | Left stick |
| Aim | Mouse | locks onto P1 | Right stick (idle = aim at enemy) |
| Basic attack | `LMB` (or `F`) | `J` | `RT` |
| Heavy / Lightning | `RMB` (or `G`) | `K` | `LT` |
| Charge / Blink | `Space` (or `Shift`) | `L` | `A` / `RB` |
| Ability Q | `Q` | `U` | `X` / `LB` |
| Ability E | `E` | `I` | `Y` |
| Ultimate R | `R` | `O` | `B` |
| Pause / mute | `Esc` / `M` | | |

Holding a button casts as soon as the ability is ready. Ground-targeted spells follow your cursor
during their short cast time.

## Classes

**Warrior**: 260 HP, 100 mana (4/s, plus 8 per sword hit), speed 5.6

| Key | Ability | Numbers | What it does |
|---|---|---|---|
| LMB | Slash | 11 dmg, 0.5s | Sword cone. Every third hit in a chain deals 17 and knocks back. |
| RMB | Cleave | 26 dmg, 20 mana, 3.5s | Wide heavy swing (0.32s wind-up), knockback, 30% slow. |
| Space | Charge | 10 dmg, 15 mana, 6s | Rush toward the cursor. Contact stuns for 0.6s and interrupts casts. |
| Q | Parry | 15 mana, 8s | 0.8s shield: blocks everything, reflects projectiles, stuns melee attackers. |
| E | Leap | 20 dmg, 25 mana, 9s | Jump to a spot. Airborne dodges everything. The landing slows. |
| R | Berserk | 40 mana, 20s | 5s: +30% speed, +25% damage, 20% lifesteal, cleanses roots and slows. |

**Mage**: 220 HP, 200 mana (14/s), speed 6.2

| Key | Ability | Numbers | What it does |
|---|---|---|---|
| LMB | Fire Bolt | 13 dmg, 4 mana, 0.45s | Instant fast projectile. Lead your target. |
| RMB | Lightning | 30 dmg, 22 mana, 2.8s | Strikes the ground 0.6s after casting. The prediction spell. |
| Space | Blink | 20 mana, 4.5s | Teleport up to 6m. |
| Q | Paralyze | 6 dmg, 30 mana, 9s | Slow orb that roots for 1.3s (roots block Charge, Leap and Blink). |
| E | Frost Nova | 12 dmg, 25 mana, 8s | Ring around you: pushes back and slows 55% for 2.5s. |
| R | Apocalypse | 55 dmg, 60 mana, 16s | Meteor lands 1.1s after casting. Combine it with Paralyze. |

Pillars block movement and projectiles. Ground spells ignore them.

## Architecture

```
contracts/protocol.js     input format, button bits, network messages (shared by everything)
services/sim/             deterministic simulation: rules, classes, combat. No DOM, no Node APIs
services/ai/              CPU opponent: sim state in, contract input out
services/server/          static file server + authoritative WebSocket rooms (/ws)
services/client/          Three.js renderer, VFX, HUD, input, audio, net client
evals/balance.mjs         bot-vs-bot balance and pace eval
scripts/share.mjs         npm run share: server + Cloudflare tunnel for internet play
```

The same `services/sim` code runs in the browser (local modes), on the server (online), in the bot
and in the eval. Online, clients send only inputs; the server steps the sim at 60Hz and streams
snapshots at 30Hz, which clients render 50ms behind with interpolation.

Each service has its own README and `test/` folder.

## Tests and evals

```bash
npm test             # gate tests: sim, bot, server, share script (node:test, ~2s)
npm run eval         # balance eval: 200 headless bot matches, fails on thresholds (~10s)
npm run eval -- 200  # more matches per pairing
```

The eval checks the numbers that define the game:

| Check | Threshold |
|---|---|
| Warrior vs Mage win rate (equal bots) | 35-65% |
| Mean round length | 12-60s |
| Casts per minute per player | at least 40 |
| Hard bot beats easy bot | at least 70% of matches |
| Matches that never finish | 0 |

Results land in `evals/results/balance-latest.json` (gitignored).

A pre-commit hook runs the gate tests. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```
