// Combat primitives shared by every ability: damage, statuses, projectiles, zones, geometry.
import { PLAYER_RADIUS, PILLARS, ARENA_RADIUS } from './constants.js';

export const enemyOf = (state, p) => state.players[1 - p.id];

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

export function emit(state, ev) {
  state.events.push(ev);
}

// Clamp an aim point to `range` from the player; returns {x, y}.
export function clampAim(p, aim, range) {
  const dx = aim.x - p.x, dy = aim.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d <= range || d === 0) return { x: aim.x, y: aim.y };
  return { x: p.x + (dx / d) * range, y: p.y + (dy / d) * range };
}

export function aimDir(p) {
  return { x: Math.cos(p.facing), y: Math.sin(p.facing) };
}

// Push a circle out of pillars and keep it inside the arena. Returns true if it collided.
export function resolveStatic(obj, r = PLAYER_RADIUS) {
  let hit = false;
  for (const pl of PILLARS) {
    const dx = obj.x - pl.x, dy = obj.y - pl.y;
    const d = Math.hypot(dx, dy);
    const min = pl.r + r;
    if (d < min) {
      const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
      obj.x = pl.x + nx * min;
      obj.y = pl.y + ny * min;
      hit = true;
    }
  }
  const d = Math.hypot(obj.x, obj.y);
  const max = ARENA_RADIUS - r;
  if (d > max) {
    obj.x *= max / d;
    obj.y *= max / d;
    hit = true;
  }
  return hit;
}

export function pointInPillar(x, y, pad = 0) {
  return PILLARS.some((pl) => dist(x, y, pl.x, pl.y) < pl.r + pad);
}

// Closest-approach test of segment (x0,y0)->(x1,y1) against a circle.
export function segmentHitsCircle(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((cx - x0) * dx + (cy - y0) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = x0 + dx * t, py = y0 + dy * t;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

export function lineOfSight(x0, y0, x1, y1) {
  return !PILLARS.some((pl) => segmentHitsCircle(x0, y0, x1, y1, pl.x, pl.y, pl.r));
}

// ---------------------------------------------------------------- statuses

export function applyStun(state, t, dur) {
  if (!t.alive || t.leap) return;
  if (t.cast) {
    emit(state, { type: 'interrupt', id: t.id, ability: t.cast.key });
    t.cast = null;
  }
  t.dash = null;
  t.parry = 0;
  t.stun = Math.max(t.stun, dur);
  emit(state, { type: 'status', id: t.id, status: 'stun', dur });
}

export function applyRoot(state, t, dur) {
  if (!t.alive || t.leap) return;
  t.root = Math.max(t.root, dur);
  t.dash = null;
  emit(state, { type: 'status', id: t.id, status: 'root', dur });
}

export function applySlow(state, t, amount, dur) {
  if (!t.alive) return;
  // A stronger slow replaces the current one; an equal one refreshes its duration.
  if (t.slowT <= 0 || amount > t.slowAmt) {
    t.slowAmt = amount;
    t.slowT = dur;
  } else if (amount === t.slowAmt) {
    t.slowT = Math.max(t.slowT, dur);
  }
  emit(state, { type: 'status', id: t.id, status: 'slow', dur });
}

export function knockback(t, fromX, fromY, force) {
  if (t.leap) return;
  let dx = t.x - fromX, dy = t.y - fromY;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) { dx = Math.cos(t.facing + Math.PI); dy = Math.sin(t.facing + Math.PI); } else { dx /= d; dy /= d; }
  t.kx += dx * force;
  t.ky += dy * force;
}

// ---------------------------------------------------------------- damage

// kind: 'melee' | 'projectile' | 'zone' | 'ring'
// Returns 'hit' | 'parried' | 'miss'.
export function dealDamage(state, src, target, amount, kind = 'melee') {
  if (!target.alive || amount <= 0) return 'miss';
  if (target.leap && kind !== 'ring') return 'miss';
  if (target.parry > 0 && src && src.id !== target.id) {
    emit(state, { type: 'parried', id: target.id, src: src.id, kind, x: target.x, y: target.y });
    if (kind === 'melee' && dist(src.x, src.y, target.x, target.y) < 4) {
      applyStun(state, src, 1.0);
      target.parry = 0;
      emit(state, { type: 'counter', id: target.id, src: src.id });
    }
    return 'parried';
  }
  let dmg = amount * (src && src.berserk > 0 ? 1.25 : 1);
  dmg = Math.max(1, Math.round(dmg));
  dmg = Math.min(dmg, Math.ceil(target.hp));
  target.hp = Math.max(0, target.hp - dmg);
  target.hitFlash = 0.12;
  if (src) {
    src.stats.damage += dmg;
    src.stats.hits += 1;
    if (src.berserk > 0) src.hp = Math.min(src.maxHp, src.hp + dmg * 0.2);
  }
  emit(state, { type: 'damage', id: target.id, src: src ? src.id : -1, amount: dmg, kind, x: target.x, y: target.y });
  if (target.hp <= 0) {
    target.alive = false;
    target.cast = null;
    target.dash = null;
    emit(state, { type: 'death', id: target.id, x: target.x, y: target.y });
  }
  return 'hit';
}

// Hits the enemy if it stands inside the cone in front of `p`. Returns the damage result or 'miss'.
export function meleeCone(state, p, range, arcDeg, onHit) {
  const e = enemyOf(state, p);
  if (!e.alive) return 'miss';
  const dx = e.x - p.x, dy = e.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d - PLAYER_RADIUS > range) return 'miss';
  let diff = Math.atan2(dy, dx) - p.facing;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  if (d > PLAYER_RADIUS * 2 && Math.abs(diff) > (arcDeg * Math.PI) / 360) return 'miss';
  return onHit(e);
}

// ---------------------------------------------------------------- projectiles & zones

export function spawnProjectile(state, p, spec) {
  const dir = aimDir(p);
  const proj = {
    id: state.nextId++,
    owner: p.id,
    kind: spec.kind,
    x: p.x + dir.x * (PLAYER_RADIUS + 0.2),
    y: p.y + dir.y * (PLAYER_RADIUS + 0.2),
    vx: dir.x * spec.speed,
    vy: dir.y * spec.speed,
    r: spec.radius,
    range: spec.range,
    traveled: 0,
    dmg: spec.dmg,
    root: spec.root || 0,
    reflected: false,
  };
  state.projectiles.push(proj);
  emit(state, { type: 'projectile', id: proj.id, owner: p.id, kind: spec.kind, x: proj.x, y: proj.y });
  return proj;
}

export function spawnZone(state, p, spec) {
  const z = {
    id: state.nextId++,
    owner: p.id,
    kind: spec.kind,
    x: spec.x,
    y: spec.y,
    r: spec.radius,
    delay: spec.delay,
    t: 0,
    dmg: spec.dmg,
    slow: spec.slow || 0,
    slowDur: spec.slowDur || 0,
  };
  state.zones.push(z);
  emit(state, { type: 'zoneStart', id: z.id, owner: p.id, kind: z.kind, x: z.x, y: z.y, r: z.r, delay: z.delay });
  return z;
}
