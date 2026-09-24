import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, step, snapshot, abilityBlocker, ringRadiusAt, constants as C, CLASSES } from '../index.js';
import { BUTTON_BIT, sanitizeInput } from '../../../contracts/protocol.js';

const idle = () => ({ mx: 0, my: 0, ax: 0, ay: 0, b: 0 });

// Match already in the fight phase, players placed where the test wants them.
function fight(classes = ['warrior', 'mage'], place) {
  const s = createMatch({ classes });
  while (s.phase !== 'fight') step(s, []);
  if (place) {
    Object.assign(s.players[0], place[0]);
    Object.assign(s.players[1], place[1]);
  }
  return s;
}

function run(s, ticks, inputs = () => []) {
  const events = [];
  for (let i = 0; i < ticks; i++) {
    step(s, inputs(i, s));
    events.push(...s.events);
  }
  return events;
}

const press = (key, aim, extra = {}) => ({ ...idle(), ax: aim.x, ay: aim.y, b: BUTTON_BIT[key], ...extra });
// Tap `key` on the first tick, keep the cursor on `aim` afterwards (windups track the cursor).
const tap = (i, key, aim) => (i === 0 ? press(key, aim) : { ...idle(), ax: aim.x, ay: aim.y });

test('match starts in countdown and turns to fight after 3s', () => {
  const s = createMatch();
  assert.equal(s.phase, 'countdown');
  const ev = run(s, C.TICK_RATE * C.COUNTDOWN + 1);
  assert.equal(s.phase, 'fight');
  assert.ok(ev.some((e) => e.type === 'fight'));
});

test('players cannot move during countdown', () => {
  const s = createMatch();
  const x0 = s.players[0].x;
  run(s, 30, () => [{ mx: 1, my: 0, ax: 0, ay: 0, b: 0 }]);
  assert.equal(s.players[0].x, x0);
});

test('movement speed matches class speed', () => {
  const s = fight(['warrior', 'mage'], [{ x: -3, y: 0 }, { x: 10, y: 0 }]);
  run(s, 60, () => [{ mx: 0, my: 1, ax: 0, ay: 20, b: 0 }]);
  assert.ok(Math.abs(s.players[0].y - CLASSES.warrior.speed) < 0.05, `y=${s.players[0].y}`);
});

test('players are blocked by pillars and the arena wall', () => {
  const s = fight(['warrior', 'mage'], [{ x: 3, y: 0 }, { x: -10, y: 0 }]);
  run(s, 120, () => [{ mx: 1, my: 0, ax: 20, ay: 0, b: 0 }]);
  const pl = C.PILLARS[0];
  assert.ok(s.players[0].x <= pl.x - pl.r - C.PLAYER_RADIUS + 1e-6, `x=${s.players[0].x}`);
  const s2 = fight(['warrior', 'mage'], [{ x: 0, y: 3 }, { x: -10, y: 0 }]);
  run(s2, 240, () => [{ mx: 0, my: -1, ax: 0, ay: -20, b: 0 }]);
  assert.ok(Math.hypot(s2.players[0].x, s2.players[0].y) <= C.ARENA_RADIUS - C.PLAYER_RADIUS + 1e-6);
});

test('warrior slash hits an enemy in front, not behind', () => {
  const s = fight(['warrior', 'mage'], [{ x: 0, y: 3 }, { x: 1.5, y: 3 }]);
  run(s, 20, () => [press('primary', { x: 5, y: 3 })]);
  assert.equal(s.players[1].hp, CLASSES.mage.hp - CLASSES.warrior.abilities.primary.dmg);

  const s2 = fight(['warrior', 'mage'], [{ x: 0, y: 3 }, { x: -1.5, y: 3 }]);
  run(s2, 20, () => [press('primary', { x: 5, y: 3 })]);
  assert.equal(s2.players[1].hp, CLASSES.mage.hp);
});

test('slash chain: third hit deals finisher damage and knocks back', () => {
  const s = fight(['warrior', 'mage'], [{ x: 0, y: 3 }, { x: 1.4, y: 3 }]);
  const ev = run(s, 90, (i, st) => [press('primary', { x: st.players[1].x, y: st.players[1].y })]);
  const dmg = ev.filter((e) => e.type === 'damage').map((e) => e.amount);
  const sl = CLASSES.warrior.abilities.primary;
  assert.deepEqual(dmg.slice(0, 3), [sl.dmg, sl.dmg, sl.finisherDmg]);
  assert.ok(s.players[1].x > 1.9, 'finisher pushes the target away');
});

test('slash restores warrior mana on hit', () => {
  const s = fight(['warrior', 'mage'], [{ x: 0, y: 3, mana: 10 }, { x: 1.5, y: 3 }]);
  run(s, 12, () => [press('primary', { x: 5, y: 3 })]);
  assert.ok(s.players[0].mana >= 18, `mana=${s.players[0].mana}`);
});

test('abilities spend mana, go on cooldown, and refuse without mana', () => {
  const s = fight(['warrior', 'mage'], [{ x: -8, y: 0 }, { x: 8, y: 0 }]);
  const m = s.players[1];
  run(s, 2, () => [idle(), press('secondary', { x: 0, y: 0 })]);
  assert.ok(m.cd.secondary > 2.5);
  assert.ok(m.mana < CLASSES.mage.mana - 20);
  assert.equal(abilityBlocker(m, 'primary'), 'busy'); // still in lightning windup
  run(s, 20);
  assert.equal(abilityBlocker(m, 'primary'), null);
  m.mana = 0;
  assert.equal(abilityBlocker(m, 'primary'), 'mana');
  const before = m.stats.casts;
  run(s, 5, () => [idle(), press('primary', { x: 0, y: 0 })]);
  assert.equal(m.stats.casts, before, 'no cast without mana');
});

test('fire bolt travels, hits, and is blocked by pillars', () => {
  const s = fight(['warrior', 'mage'], [{ x: 4, y: 3 }, { x: -4, y: 3 }]);
  const ev = run(s, 60, (i) => [idle(), tap(i, 'primary', { x: 4, y: 3 })]);
  assert.ok(ev.some((e) => e.type === 'projHit' && e.target === 0));
  assert.equal(s.players[0].hp, CLASSES.warrior.hp - CLASSES.mage.abilities.primary.dmg);

  const s2 = fight(['warrior', 'mage'], [{ x: 10, y: 0 }, { x: 3, y: 0 }]);
  const ev2 = run(s2, 60, (i) => [idle(), tap(i, 'primary', { x: 10, y: 0 })]);
  assert.ok(ev2.some((e) => e.type === 'projHit' && e.target === -1), 'pillar at x=7 stops the bolt');
  assert.equal(s2.players[0].hp, CLASSES.warrior.hp);
});

test('lightning hits after its delay only if the target is still there', () => {
  const s = fight(['warrior', 'mage'], [{ x: 3, y: 3 }, { x: -3, y: -3 }]);
  const ev = run(s, 60, (i) => [idle(), tap(i, 'secondary', { x: 3, y: 3 })]);
  const blast = ev.find((e) => e.type === 'zoneBlast');
  assert.ok(blast);
  assert.equal(s.players[0].hp, CLASSES.warrior.hp - CLASSES.mage.abilities.secondary.dmg);

  // Same cast, but the warrior walks out: predicted wrong, no damage.
  const s2 = fight(['warrior', 'mage'], [{ x: 3, y: 3 }, { x: -3, y: -3 }]);
  run(s2, 60, (i) => [{ mx: 1, my: 0, ax: 10, ay: 3, b: 0 }, tap(i, 'secondary', { x: 3, y: 3 })]);
  assert.equal(s2.players[0].hp, CLASSES.warrior.hp);
});

test('paralyze roots and blocks mobility until it wears off', () => {
  const s = fight(['warrior', 'mage'], [{ x: 3, y: 3 }, { x: -3, y: 3 }]);
  run(s, 50, (i) => [idle(), tap(i, 'q', { x: 3, y: 3 })]);
  const w = s.players[0];
  assert.ok(w.root > 0);
  assert.equal(abilityBlocker(w, 'dash'), 'rooted');
  const x = w.x;
  run(s, 10, () => [{ mx: 1, my: 0, ax: 10, ay: 3, b: 0 }]);
  assert.equal(w.x, x);
});

test('charge stuns on contact and interrupts a cast', () => {
  const s = fight(['warrior', 'mage'], [{ x: -3, y: 3 }, { x: 1, y: 3 }]);
  // Mage starts Apocalypse windup, warrior charges into it.
  const ev = run(s, 12, (i) => [i === 1 ? press('dash', { x: 1, y: 3 }) : idle(), tap(i, 'r', { x: -3, y: 3 })]);
  assert.ok(ev.some((e) => e.type === 'interrupt' && e.id === 1));
  assert.ok(s.players[1].stun > 0);
  assert.equal(s.zones.length, 0, 'interrupted apocalypse never lands');
});

test('parry blocks melee and stuns the attacker', () => {
  const s = fight(['warrior', 'warrior'], [{ x: 0, y: 3 }, { x: 1.5, y: 3 }]);
  const ev = run(s, 20, (i) => [press('primary', { x: 5, y: 3 }), tap(i, 'q', { x: 0, y: 3 })]);
  assert.equal(s.players[1].hp, CLASSES.warrior.hp);
  assert.ok(ev.some((e) => e.type === 'counter'));
  assert.ok(s.players[0].stun > 0);
});

test('parry reflects projectiles back at the caster', () => {
  const s = fight(['warrior', 'mage'], [{ x: 4, y: 3 }, { x: -4, y: 3 }]);
  const ev = run(s, 90, (i) => [tap(i, 'q', { x: -4, y: 3 }), tap(i, 'primary', { x: 4, y: 3 })]);
  assert.ok(ev.some((e) => e.type === 'reflect'));
  assert.equal(s.players[0].hp, CLASSES.warrior.hp);
  assert.equal(s.players[1].hp, CLASSES.mage.hp - CLASSES.mage.abilities.primary.dmg);
});

test('leap dodges projectiles mid-air and damages on landing', () => {
  const s = fight(['warrior', 'mage'], [{ x: -4, y: 3 }, { x: 3, y: 3 }]);
  const ev = run(s, 50, (i) => [tap(i, 'e', { x: 3, y: 3 }), tap(i, 'primary', { x: -4, y: 3 })]);
  assert.ok(ev.some((e) => e.type === 'land'));
  assert.equal(s.players[0].hp, CLASSES.warrior.hp, 'bolt passes under the leap');
  assert.ok(s.players[1].hp <= CLASSES.mage.hp - CLASSES.warrior.abilities.e.dmg);
});

test('frost nova pushes away and slows', () => {
  const s = fight(['warrior', 'mage'], [{ x: 1.5, y: 3 }, { x: 0, y: 3 }]);
  run(s, 20, (i) => [idle(), tap(i, 'e', { x: 0, y: 0 })]);
  assert.ok(s.players[0].slowT > 0);
  assert.ok(s.players[0].x > 2.5);
});

test('blink teleports toward cursor but never into a pillar', () => {
  const s = fight(['warrior', 'mage'], [{ x: -10, y: -3 }, { x: 3, y: 0 }]);
  run(s, 2, () => [idle(), press('dash', { x: 7, y: 0 })]);
  const m = s.players[1];
  assert.ok(Math.hypot(m.x - 7, m.y) >= 1 + C.PLAYER_RADIUS - 1e-6);
  assert.ok(m.x > 5);
});

test('berserk boosts damage and heals through lifesteal', () => {
  const s = fight(['warrior', 'mage'], [{ x: 0, y: 3, hp: 100 }, { x: 1.5, y: 3 }]);
  run(s, 20, (i) => [i === 0 ? press('r', { x: 5, y: 3 }) : press('primary', { x: 5, y: 3 })]);
  assert.equal(s.players[1].hp, CLASSES.mage.hp - Math.round(CLASSES.warrior.abilities.primary.dmg * 1.25));
  assert.ok(s.players[0].hp > 100);
});

test('health orb spawns, heals and respawns', () => {
  const s = fight(['warrior', 'mage'], [{ x: -8, y: 0, hp: 100 }, { x: 8, y: 0 }]);
  s.fightTime = C.ORB.firstSpawn;
  run(s, 1);
  assert.ok(s.orb.active);
  s.players[0].x = 0; s.players[0].y = 0;
  const ev = run(s, 1);
  assert.ok(ev.some((e) => e.type === 'orbTaken' && e.id === 0));
  assert.equal(s.players[0].hp, 100 + C.ORB.heal);
  assert.ok(!s.orb.active);
});

test('ring of fire closes and burns players outside', () => {
  assert.equal(ringRadiusAt(0), C.ARENA_RADIUS);
  assert.equal(ringRadiusAt(C.RING.start + C.RING.duration + 5), C.RING.minRadius);
  const s = fight(['warrior', 'mage'], [{ x: -10, y: 0 }, { x: 0, y: 1 }]);
  s.fightTime = C.RING.start + C.RING.duration;
  run(s, 60);
  assert.ok(s.players[0].hp < CLASSES.warrior.hp - 10);
  assert.equal(s.players[1].hp, CLASSES.mage.hp);
});

test('killing the enemy ends the round, first to 3 wins the match', () => {
  const s = fight(['warrior', 'mage'], [{ x: 0, y: 3 }, { x: 1.5, y: 3, hp: 5 }]);
  const ev = run(s, 20, () => [press('primary', { x: 5, y: 3 })]);
  assert.ok(ev.some((e) => e.type === 'death' && e.id === 1));
  assert.equal(s.phase, 'roundEnd');
  assert.deepEqual(s.score, [1, 0]);
  run(s, C.TICK_RATE * C.ROUND_END + 2);
  assert.equal(s.phase, 'countdown');
  assert.equal(s.round, 2);
  assert.equal(s.players[1].hp, CLASSES.mage.hp, 'round reset restores hp');

  s.score = [2, 0];
  while (s.phase !== 'fight') step(s, []);
  s.players[1].hp = 1;
  Object.assign(s.players[0], { x: 0, y: 3 });
  Object.assign(s.players[1], { x: 1.5, y: 3 });
  run(s, 20, () => [press('primary', { x: 5, y: 3 })]);
  run(s, C.TICK_RATE * C.ROUND_END + 2);
  assert.equal(s.phase, 'matchEnd');
  assert.equal(s.winner, 0);
});

test('simulation is deterministic for identical inputs', () => {
  const script = (i) => [
    { mx: Math.sin(i / 20), my: Math.cos(i / 30), ax: 0, ay: 0, b: i % 50 === 0 ? BUTTON_BIT.dash : BUTTON_BIT.primary },
    { mx: -Math.cos(i / 25), my: Math.sin(i / 15), ax: -3, ay: 2, b: i % 90 < 3 ? BUTTON_BIT.secondary : BUTTON_BIT.primary },
  ];
  const a = createMatch({ seed: 7 });
  const b = createMatch({ seed: 7 });
  run(a, 1500, script);
  run(b, 1500, script);
  assert.deepEqual(snapshot(a), snapshot(b));
});

test('snapshot is JSON round-trippable', () => {
  const s = fight();
  run(s, 30, () => [press('primary', { x: 0, y: 0 }), press('secondary', { x: -6, y: 6 })]);
  const snap = snapshot(s);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test('sanitizeInput clamps garbage from the network', () => {
  assert.deepEqual(sanitizeInput(null), { mx: 0, my: 0, ax: 0, ay: 0, b: 0 });
  const i = sanitizeInput({ mx: 5, my: 5, ax: NaN, ay: 1e9, b: 0xffff });
  assert.ok(Math.hypot(i.mx, i.my) <= 1 + 1e-9);
  assert.equal(i.ax, 0);
  assert.equal(i.ay, 100);
  assert.equal(i.b, 63);
  assert.deepEqual(sanitizeInput({ mx: '1', b: 1.5 }), { mx: 0, my: 0, ax: 0, ay: 0, b: 0 });
});
