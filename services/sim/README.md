# sim

Deterministic 1v1 duel simulation. Pure ES modules with no DOM and no Node APIs, so the browser,
the server, the bot and the eval all run the same code.

```js
import { createMatch, step, snapshot } from './index.js';
const s = createMatch({ classes: ['warrior', 'mage'], seed: 1 });
step(s, [input0, input1]);   // one 1/60s tick; inputs follow contracts/protocol.js
s.events                     // one-shot events from this tick (damage, cast, zoneBlast, ...)
snapshot(s)                  // JSON-safe view for the network and the renderer
```

| File | Contents |
|---|---|
| `constants.js` | arena, pillars, spawns, round timing, orb, ring of fire |
| `classes.js` | Warrior and Mage stats and abilities. Numbers live here as `dmg`, `cost`, `cooldown`, ... |
| `combat.js` | damage, parry, stun/root/slow, knockback, projectiles, zones, collision |
| `index.js` | match lifecycle, per-tick update, snapshot |

Rules worth knowing: holding a button casts as soon as it is ready; wind-ups keep tracking the
aim point; stuns cancel casts (and spend the mana); roots block mobility abilities; parry blocks
everything and reflects projectiles; leap is airborne and cannot be hit.

Tests: `node --test services/sim/test/`. Balance changes go through `npm run eval`.
