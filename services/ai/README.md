# ai

CPU opponent. `createBot({ difficulty, seed }).think(state, slot)` returns an input in the
`contracts/protocol.js` format once per tick. It sees the same state a player sees and is held to
the same cooldowns and mana.

| Knob | easy | normal | hard |
|---|---|---|---|
| re-think interval (reaction) | 0.30s | 0.15s | 0.07s |
| aim noise (m) | 1.4 | 0.7 | 0.25 |
| target leading | 35% | 75% | 100% |
| dodge chance per threat | 25% | 60% | 90% |

Warrior: closes distance, charges and leaps to predicted positions, parries incoming projectiles.
Mage: kites at about 7.5m, leads bolts and lightning, keeps 45 mana in reserve to Nova + Blink
out of melee, drops Apocalypse on rooted or stunned targets.

Tests: `node --test services/ai/test/`.
