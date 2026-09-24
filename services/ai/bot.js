// CPU opponent. Reads the sim state, returns an input in the shared contract format.
// It plays by the same rules as a human: same inputs, same cooldowns, no hidden information.
// Skill knobs: how often it re-thinks (reaction time), aim noise, how well it leads targets,
// and how often it dodges telegraphed threats.
import { constants as C, CLASSES, abilityBlocker } from '../sim/index.js';
import { lineOfSight, dist } from '../sim/combat.js';
import { BUTTON_BIT } from '../../contracts/protocol.js';

export const DIFFICULTY = Object.freeze({
  easy: { think: 0.3, aimError: 1.4, lead: 0.35, dodge: 0.25, aggression: 0.55 },
  normal: { think: 0.15, aimError: 0.7, lead: 0.75, dodge: 0.6, aggression: 0.8 },
  hard: { think: 0.07, aimError: 0.25, lead: 1.0, dodge: 0.9, aggression: 1.0 },
});

function mulberry32(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (x, y) => {
  const d = Math.hypot(x, y);
  return d > 1e-6 ? { x: x / d, y: y / d } : { x: 0, y: 0 };
};

export function createBot({ difficulty = 'normal', seed = 1 } = {}) {
  const skill = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const rand = mulberry32(seed);
  const decided = new Map(); // threat id -> will dodge?
  let timer = 0;
  let strafe = 1;
  let strafeTimer = 0;
  let current = { mx: 0, my: 0, ax: 0, ay: 0, b: 0 };

  const noise = () => (rand() + rand() - 1) * skill.aimError;

  // Where the target will be after `t` seconds if it keeps moving the same way.
  function predict(target, t) {
    const k = t * skill.lead;
    return { x: target.x + target.vx * k + noise(), y: target.y + target.vy * k + noise() };
  }

  function willDodge(id) {
    if (!decided.has(id)) decided.set(id, rand() < skill.dodge);
    return decided.get(id);
  }

  // Most urgent incoming threat: {dir to escape, eta, kind} or null.
  function threat(state, me) {
    let best = null;
    for (const pr of state.projectiles) {
      if (pr.owner === me.id) continue;
      const rx = me.x - pr.x, ry = me.y - pr.y;
      const v2 = pr.vx * pr.vx + pr.vy * pr.vy;
      const tc = (rx * pr.vx + ry * pr.vy) / v2;
      if (tc <= 0 || tc > 0.8) continue;
      const cx = pr.x + pr.vx * tc - me.x, cy = pr.y + pr.vy * tc - me.y;
      if (Math.hypot(cx, cy) > C.PLAYER_RADIUS + pr.r + 0.35) continue;
      if (!willDodge(pr.id)) continue;
      // Step perpendicular to the flight path, away from the closest-approach point.
      let side = norm(-pr.vy, pr.vx);
      if (side.x * -cx + side.y * -cy < 0) side = { x: -side.x, y: -side.y };
      if (!best || tc < best.eta) best = { dir: side, eta: tc, kind: 'projectile' };
    }
    for (const z of state.zones) {
      if (z.owner === me.id) continue;
      const d = dist(me.x, me.y, z.x, z.y);
      const eta = z.delay - z.t;
      if (d > z.r + C.PLAYER_RADIUS + 0.4 || !willDodge(z.id)) continue;
      const out = d > 0.05 ? norm(me.x - z.x, me.y - z.y) : norm(-me.y, me.x);
      if (!best || eta < best.eta) best = { dir: out, eta, kind: 'zone', zone: z };
    }
    return best;
  }

  function ready(me, key) {
    return abilityBlocker(me, key) === null;
  }

  // Can afford `key` and still keep `reserve` mana for an escape afterwards.
  function affordable(me, key, reserve) {
    return ready(me, key) && me.mana - CLASSES[me.cls].abilities[key].cost >= reserve;
  }

  function warrior(state, me, foe, input) {
    const d = dist(me.x, me.y, foe.x, foe.y);
    const to = norm(foe.x - me.x, foe.y - me.y);
    const side = { x: -to.y * strafe, y: to.x * strafe };
    input.mx = to.x + side.x * 0.25;
    input.my = to.y + side.y * 0.25;
    const aim = predict(foe, 0.15);
    input.ax = aim.x;
    input.ay = aim.y;
    if (d < 2.6) {
      input.b |= BUTTON_BIT.primary;
      if (ready(me, 'secondary') && rand() < 0.35 * skill.aggression) input.b |= BUTTON_BIT.secondary;
      if (ready(me, 'r') && foe.hp > foe.maxHp * 0.35 && rand() < skill.aggression) input.b |= BUTTON_BIT.r;
    } else if (d < 7 && ready(me, 'dash') && foe.stun <= 0 && rand() < 0.5 * skill.aggression &&
               lineOfSight(me.x, me.y, foe.x, foe.y)) {
      const at = predict(foe, d / 27);
      input.ax = at.x;
      input.ay = at.y;
      input.b |= BUTTON_BIT.dash;
    } else if (d > 5 && d < 9 && ready(me, 'e') && rand() < 0.4 * skill.aggression) {
      const at = predict(foe, 0.55);
      input.ax = at.x;
      input.ay = at.y;
      input.b |= BUTTON_BIT.e;
    }
  }

  function mage(state, me, foe, input) {
    const d = dist(me.x, me.y, foe.x, foe.y);
    const to = norm(foe.x - me.x, foe.y - me.y);
    const side = { x: -to.y * strafe, y: to.x * strafe };
    const want = foe.cls === 'warrior' ? 7.5 : 6.5;
    let rad = d < want - 1.5 ? -1 : d > want + 2 ? 1 : 0;
    input.mx = to.x * rad + side.x;
    input.my = to.y * rad + side.y;
    const r = Math.hypot(me.x, me.y);
    if (r > state.ringRadius - 3) { // do not get pinned against the edge
      input.mx -= (me.x / r) * 1.4;
      input.my -= (me.y / r) * 1.4;
    }
    const los = lineOfSight(me.x, me.y, foe.x, foe.y);
    const locked = foe.stun > 0.3 || foe.root > 0.3;
    // Against melee, always keep enough mana to Nova + Blink out.
    const reserve = foe.cls === 'warrior' ? 45 : 20;

    if (d < 3.2 && ready(me, 'e')) input.b |= BUTTON_BIT.e;
    else if (d < 3.8 && me.cd.e > 0 && ready(me, 'dash')) {
      const away = norm(me.x - foe.x + side.x, me.y - foe.y + side.y);
      input.ax = me.x + away.x * 6 - me.x * 0.3;
      input.ay = me.y + away.y * 6 - me.y * 0.3;
      input.b |= BUTTON_BIT.dash;
      return;
    }

    if (affordable(me, 'r', locked ? 0 : reserve) && d < 10.5 && (locked || rand() < 0.08 * skill.aggression)) {
      const at = locked ? { x: foe.x, y: foe.y } : predict(foe, 1.45);
      input.ax = at.x; input.ay = at.y; input.b |= BUTTON_BIT.r;
    } else if (affordable(me, 'q', reserve) && los && d < 9.5 && rand() < 0.5 * skill.aggression) {
      const at = predict(foe, 0.15 + d / 13);
      input.ax = at.x; input.ay = at.y; input.b |= BUTTON_BIT.q;
    } else if (affordable(me, 'secondary', reserve) && d < 10.5 && rand() < 0.7 * skill.aggression) {
      const at = locked ? { x: foe.x, y: foe.y } : predict(foe, 0.8);
      input.ax = at.x; input.ay = at.y; input.b |= BUTTON_BIT.secondary;
    } else if (los && d < 13 && (me.mana > reserve * 0.5 || d > 6)) {
      const at = predict(foe, 0.08 + d / 19);
      input.ax = at.x; input.ay = at.y; input.b |= BUTTON_BIT.primary;
    } else {
      input.ax = foe.x; input.ay = foe.y;
    }
  }

  function decide(state, me) {
    const foe = state.players[1 - me.id];
    const input = { mx: 0, my: 0, ax: foe.x, ay: foe.y, b: 0 };
    if (state.phase !== 'fight' || !me.alive || !foe.alive) return input;

    strafeTimer -= skill.think;
    if (strafeTimer <= 0) { strafe = rand() < 0.5 ? -1 : 1; strafeTimer = 0.6 + rand() * 1.4; }

    if (CLASSES[me.cls].id === 'warrior') warrior(state, me, foe, input);
    else mage(state, me, foe, input);

    // Health orb when hurt and closer than the enemy.
    if (state.orb.active && me.hp < me.maxHp * 0.7 &&
        dist(me.x, me.y, C.ORB.x, C.ORB.y) < dist(foe.x, foe.y, C.ORB.x, C.ORB.y)) {
      const o = norm(C.ORB.x - me.x, C.ORB.y - me.y);
      input.mx = o.x; input.my = o.y;
    }
    // Stay inside the ring of fire.
    const r = Math.hypot(me.x, me.y);
    if (r > state.ringRadius - 1.2) { input.mx = -me.x / r; input.my = -me.y / r; }

    const t = threat(state, me);
    if (t) {
      input.mx = t.dir.x;
      input.my = t.dir.y;
      if (me.cls === 'warrior' && t.eta < 0.35 && ready(me, 'q')) input.b = BUTTON_BIT.q;
      else if (me.cls === 'mage' && t.kind === 'zone' && t.zone.kind === 'apocalypse' && ready(me, 'dash')) {
        input.ax = me.x + t.dir.x * 6; input.ay = me.y + t.dir.y * 6; input.b = BUTTON_BIT.dash;
      } else if (me.cls === 'warrior' && t.kind === 'zone' && t.zone.kind === 'apocalypse' && ready(me, 'e')) {
        input.ax = me.x + t.dir.x * 7; input.ay = me.y + t.dir.y * 7; input.b = BUTTON_BIT.e;
      }
    }
    const m = norm(input.mx, input.my);
    input.mx = m.x;
    input.my = m.y;
    return input;
  }

  return {
    skill,
    // Call once per sim tick; returns the input for player `id`.
    think(state, id) {
      timer -= C.DT;
      if (timer <= 0) {
        timer = skill.think * (0.7 + rand() * 0.6);
        current = decide(state, state.players[id]);
      }
      return current;
    },
  };
}
