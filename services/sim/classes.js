// Class and ability definitions. Numbers here are the balance surface; evals/balance.mjs measures them.
//
// Ability shape:
//   name, desc, cost (mana), cooldown (s), windup (s, cast time; aim keeps tracking during it)
//   range      optional max distance for ground-targeted abilities (aim is clamped)
//   mobility   true for movement abilities, which roots block
//   dmg etc.   tuning numbers read by release() through `this`, and by HUD tooltips and tests
//   release(state, p, aim)   executes the ability once the windup has elapsed (called as a method)
import {
  enemyOf, emit, clampAim, aimDir, dist, resolveStatic, dealDamage, meleeCone,
  applyStun, applySlow, knockback, spawnProjectile, spawnZone,
} from './combat.js';
import { PLAYER_RADIUS } from './constants.js';

const WARRIOR = {
  id: 'warrior',
  name: 'Warrior',
  hp: 260,
  mana: 100,
  manaRegen: 4,
  speed: 5.6,
  abilities: {
    primary: {
      name: 'Slash',
      desc: 'Sword swing in front of you. Every third hit in a chain knocks back. Restores mana on hit.',
      cost: 0, cooldown: 0.5, windup: 0.1, dmg: 11, finisherDmg: 17, range: 2.3, arc: 110,
      release(state, p) {
        const combo = p.comboT > 0 ? (p.combo % 3) + 1 : 1;
        p.combo = combo;
        p.comboT = 1.2;
        const finisher = combo === 3;
        emit(state, { type: 'swing', id: p.id, ability: 'primary', combo, facing: p.facing, range: this.range, arc: this.arc });
        const res = meleeCone(state, p, this.range, this.arc, (e) => {
          const r = dealDamage(state, p, e, finisher ? this.finisherDmg : this.dmg, 'melee');
          if (r === 'hit') {
            p.mana = Math.min(p.maxMana, p.mana + 8);
            if (finisher) knockback(e, p.x, p.y, 7);
          }
          return r;
        });
        return res;
      },
    },
    secondary: {
      name: 'Cleave',
      desc: 'Heavy two-handed arc. Big damage, knockback and a short slow.',
      cost: 20, cooldown: 3.5, windup: 0.32, dmg: 26, range: 2.9, arc: 170,
      release(state, p) {
        emit(state, { type: 'swing', id: p.id, ability: 'secondary', facing: p.facing, range: this.range, arc: this.arc });
        return meleeCone(state, p, this.range, this.arc, (e) => {
          const r = dealDamage(state, p, e, this.dmg, 'melee');
          if (r === 'hit') {
            knockback(e, p.x, p.y, 10);
            applySlow(state, e, 0.3, 1);
          }
          return r;
        });
      },
    },
    dash: {
      name: 'Charge',
      desc: 'Rush toward the cursor. Slamming into the enemy stuns them.',
      cost: 15, cooldown: 6, windup: 0, mobility: true, dmg: 10, stun: 0.6,
      release(state, p) {
        const d = aimDir(p);
        p.dash = { dx: d.x, dy: d.y, t: 0, dur: 0.26, speed: 27, hit: false };
        emit(state, { type: 'dash', id: p.id, x: p.x, y: p.y });
      },
    },
    q: {
      name: 'Parry',
      desc: 'Raise your shield for 0.8s. Blocks all damage, reflects projectiles and stuns melee attackers.',
      cost: 15, cooldown: 8, windup: 0,
      release(state, p) {
        p.parry = 0.8;
        emit(state, { type: 'parryStart', id: p.id });
      },
    },
    e: {
      name: 'Leap',
      desc: 'Jump to the target spot, dodging everything in the air. Landing damages and slows.',
      cost: 25, cooldown: 9, windup: 0, range: 8, mobility: true, dmg: 20,
      release(state, p, aim) {
        const to = clampAim(p, aim, 8);
        resolveStatic(to);
        p.leap = { sx: p.x, sy: p.y, tx: to.x, ty: to.y, t: 0, dur: 0.55 };
        p.dash = null;
        emit(state, { type: 'leap', id: p.id, x: p.x, y: p.y, tx: to.x, ty: to.y });
      },
    },
    r: {
      name: 'Berserk',
      desc: 'For 5s: +30% speed, +25% damage, 20% lifesteal. Cleanses roots and slows.',
      cost: 40, cooldown: 20, windup: 0,
      release(state, p) {
        p.berserk = 5;
        p.root = 0;
        p.slowT = 0;
        emit(state, { type: 'berserk', id: p.id });
      },
    },
  },
};

const MAGE = {
  id: 'mage',
  name: 'Mage',
  hp: 220,
  mana: 200,
  manaRegen: 14,
  speed: 6.2,
  abilities: {
    primary: {
      name: 'Fire Bolt',
      desc: 'Fast fire projectile. Lead your target.',
      cost: 4, cooldown: 0.45, windup: 0, dmg: 13, speed: 19,
      release(state, p) {
        spawnProjectile(state, p, { kind: 'firebolt', speed: this.speed, radius: 0.3, range: 13, dmg: this.dmg });
      },
    },
    secondary: {
      name: 'Lightning',
      desc: 'Call lightning on the ground after 0.6s. Predict where they will be.',
      cost: 22, cooldown: 2.8, windup: 0.2, range: 10, dmg: 30, radius: 1.5, delay: 0.6,
      release(state, p, aim) {
        const at = clampAim(p, aim, this.range);
        spawnZone(state, p, { kind: 'lightning', x: at.x, y: at.y, radius: this.radius, delay: this.delay, dmg: this.dmg, slow: 0.25, slowDur: 0.6 });
      },
    },
    dash: {
      name: 'Blink',
      desc: 'Teleport up to 6m toward the cursor.',
      cost: 20, cooldown: 4.5, windup: 0, mobility: true,
      release(state, p, aim) {
        const to = clampAim(p, aim, 6);
        const from = { x: p.x, y: p.y };
        p.x = to.x;
        p.y = to.y;
        resolveStatic(p);
        emit(state, { type: 'blink', id: p.id, x: from.x, y: from.y, tx: p.x, ty: p.y });
      },
    },
    q: {
      name: 'Paralyze',
      desc: 'Slow arcane orb that roots the enemy for 1.3s.',
      cost: 30, cooldown: 9, windup: 0.15, dmg: 6, speed: 13,
      release(state, p) {
        spawnProjectile(state, p, { kind: 'paralyze', speed: this.speed, radius: 0.4, range: 11, dmg: this.dmg, root: 1.3 });
      },
    },
    e: {
      name: 'Frost Nova',
      desc: 'Ice explodes around you: damages, pushes away and slows by 55% for 2.5s.',
      cost: 25, cooldown: 8, windup: 0, dmg: 12, radius: 3.2,
      release(state, p) {
        emit(state, { type: 'nova', id: p.id, x: p.x, y: p.y, r: this.radius });
        const e = enemyOf(state, p);
        if (e.alive && dist(p.x, p.y, e.x, e.y) <= this.radius + PLAYER_RADIUS) {
          if (dealDamage(state, p, e, this.dmg, 'zone') === 'hit') {
            knockback(e, p.x, p.y, 9);
            applySlow(state, e, 0.55, 2.5);
          }
        }
      },
    },
    r: {
      name: 'Apocalypse',
      desc: 'Huge meteor strike after 1.1s. Devastating if it lands.',
      cost: 60, cooldown: 16, windup: 0.35, range: 10, dmg: 55, radius: 2.6, delay: 1.1,
      release(state, p, aim) {
        const at = clampAim(p, aim, this.range);
        spawnZone(state, p, { kind: 'apocalypse', x: at.x, y: at.y, radius: this.radius, delay: this.delay, dmg: this.dmg });
      },
    },
  },
};

export const CLASSES = Object.freeze({ warrior: WARRIOR, mage: MAGE });

// Charge contact: called every tick while dashing.
export function chargeContact(state, p) {
  const e = enemyOf(state, p);
  if (!e.alive || p.dash.hit) return false;
  if (dist(p.x, p.y, e.x, e.y) > PLAYER_RADIUS * 2 + 0.3) return false;
  p.dash.hit = true;
  const ab = WARRIOR.abilities.dash;
  const r = dealDamage(state, p, e, ab.dmg, 'melee');
  if (r === 'hit') {
    applyStun(state, e, ab.stun);
    knockback(e, p.x, p.y, 4);
  }
  emit(state, { type: 'chargeHit', id: p.id, x: e.x, y: e.y, result: r });
  return true;
}

// Leap landing AoE.
export function leapLand(state, p) {
  emit(state, { type: 'land', id: p.id, x: p.x, y: p.y, r: 2.2 });
  const e = enemyOf(state, p);
  if (e.alive && dist(p.x, p.y, e.x, e.y) <= 2.2 + PLAYER_RADIUS) {
    if (dealDamage(state, p, e, WARRIOR.abilities.e.dmg, 'melee') === 'hit') applySlow(state, e, 0.4, 1.5);
  }
}
