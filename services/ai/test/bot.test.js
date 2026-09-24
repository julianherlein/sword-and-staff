import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, step, sanitizeInput, constants as C } from '../../sim/index.js';
import { createBot, DIFFICULTY } from '../bot.js';

function fightState(classes) {
  const s = createMatch({ classes });
  while (s.phase !== 'fight') step(s, []);
  return s;
}

test('bot inputs always satisfy the input contract', () => {
  for (const cls of ['warrior', 'mage']) {
    const s = fightState([cls, cls]);
    const bots = [createBot({ seed: 1 }), createBot({ seed: 2 })];
    for (let i = 0; i < 600; i++) {
      const ins = [bots[0].think(s, 0), bots[1].think(s, 1)];
      for (const inp of ins) {
        const clean = sanitizeInput(inp);
        for (const k of ['mx', 'my', 'ax', 'ay']) assert.ok(Math.abs(clean[k] - inp[k]) < 1e-9, `${k}: ${inp[k]}`);
        assert.equal(clean.b, inp.b);
      }
      step(s, ins);
    }
  }
});

test('each class bot kills an idle target', () => {
  for (const cls of ['warrior', 'mage']) {
    const s = fightState([cls, 'warrior']);
    const bot = createBot({ difficulty: 'normal', seed: 3 });
    let ticks = 0;
    while (s.phase === 'fight' && ticks < C.TICK_RATE * 60) {
      step(s, [bot.think(s, 0), null]);
      ticks++;
    }
    assert.deepEqual(s.score, [1, 0], `${cls} bot failed to win in 60s`);
  }
});

test('mage bot leads a moving target with lightning', () => {
  const s = fightState(['mage', 'warrior']);
  Object.assign(s.players[0], { x: -9, y: 0 });
  Object.assign(s.players[1], { x: -3, y: 5, vx: 0, vy: 0 });
  // The warrior walks steadily toward -y (clear of pillars); the bot should aim ahead of it.
  const bot = createBot({ difficulty: 'hard', seed: 9 });
  const aims = [];
  for (let i = 0; i < 240 && aims.length < 1; i++) {
    const inp = bot.think(s, 0);
    step(s, [inp, { mx: 0, my: -1, ax: 0, ay: -20, b: 0 }]);
    for (const e of s.events) if (e.type === 'zoneStart' && e.owner === 0) aims.push({ zy: e.y, wy: s.players[1].y });
  }
  assert.ok(aims.length > 0, 'bot never cast lightning');
  assert.ok(aims[0].zy < aims[0].wy - 1, `expected lead below target: ${JSON.stringify(aims)}`);
});

test('hard bot dodges a fire bolt more often than easy bot', () => {
  const dodgeRate = (difficulty) => {
    let dodged = 0;
    const trials = 40;
    for (let k = 0; k < trials; k++) {
      const s = fightState(['mage', 'warrior']); // a charging warrior only sidesteps when it dodges
      Object.assign(s.players[0], { x: -8, y: 3 });
      Object.assign(s.players[1], { x: 1, y: 3 }); // 9m: ~0.47s of flight to react
      const bot = createBot({ difficulty, seed: 100 + k });
      let hit = false;
      for (let i = 0; i < 70; i++) {
        const shooter = i === 0 // y=3 keeps the bolt clear of the pillar at (-7,0)
           ? { mx: 0, my: 0, ax: 1, ay: 3, b: 1 } : { mx: 0, my: 0, ax: 1, ay: 3, b: 0 };
        step(s, [shooter, bot.think(s, 1)]);
        if (s.events.some((e) => e.type === 'damage' && e.id === 1)) hit = true;
      }
      if (!hit) dodged++;
    }
    return dodged / trials;
  };
  const easy = dodgeRate('easy');
  const hard = dodgeRate('hard');
  assert.ok(hard > easy + 0.2, `hard ${hard} vs easy ${easy}`);
  assert.ok(hard >= 0.5, `hard bot dodged only ${hard}`);
});

test('difficulty table is ordered from easy to hard', () => {
  assert.ok(DIFFICULTY.easy.think > DIFFICULTY.normal.think && DIFFICULTY.normal.think > DIFFICULTY.hard.think);
  assert.ok(DIFFICULTY.easy.dodge < DIFFICULTY.hard.dodge);
});
