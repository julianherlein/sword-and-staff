// Deterministic 1v1 duel simulation. Pure data in, pure data out: no DOM, no Node APIs.
// Used verbatim by the browser (local play), the server (authoritative online play),
// the bot and the balance eval.
import * as C from './constants.js';
import { CLASSES, chargeContact, leapLand } from './classes.js';
import {
  emit, dist, resolveStatic, segmentHitsCircle, dealDamage, applyRoot, applySlow, enemyOf,
} from './combat.js';
import { BUTTONS, held, emptyInput, sanitizeInput } from '../../contracts/protocol.js';

export { C as constants, CLASSES, BUTTONS, emptyInput, sanitizeInput };

// Ability trigger priority when several buttons are held on the same tick.
const TRIGGER_ORDER = ['dash', 'q', 'e', 'r', 'secondary', 'primary'];

function createPlayer(id, cls) {
  const def = CLASSES[cls];
  if (!def) throw new Error(`unknown class ${cls}`);
  return {
    id, cls,
    x: 0, y: 0, z: 0, facing: 0, vx: 0, vy: 0, kx: 0, ky: 0,
    hp: def.hp, maxHp: def.hp, mana: def.mana, maxMana: def.mana,
    alive: true,
    cd: Object.fromEntries(BUTTONS.map((k) => [k, 0])),
    cast: null, dash: null, leap: null,
    stun: 0, root: 0, slowT: 0, slowAmt: 0, parry: 0, berserk: 0,
    combo: 0, comboT: 0, hitFlash: 0, ringAcc: 0, moving: false,
    stats: { damage: 0, hits: 0, casts: 0 },
  };
}

function resetPlayer(p, spawn, facing) {
  const fresh = createPlayer(p.id, p.cls);
  fresh.stats = p.stats;
  Object.assign(p, fresh, { x: spawn.x, y: spawn.y, facing });
}

function resetRound(state) {
  const [a, b] = C.SPAWNS;
  resetPlayer(state.players[0], a, Math.atan2(b.y - a.y, b.x - a.x));
  resetPlayer(state.players[1], b, Math.atan2(a.y - b.y, a.x - b.x));
  state.projectiles = [];
  state.zones = [];
  state.orb = { active: false, respawnAt: C.ORB.firstSpawn };
  state.ringRadius = C.ARENA_RADIUS;
  state.phase = 'countdown';
  state.phaseTime = 0;
  state.fightTime = 0;
  state.roundWinner = -1;
}

export function createMatch({ classes = ['warrior', 'mage'], seed = 1, winsNeeded = C.WINS_NEEDED } = {}) {
  const state = {
    tick: 0, t: 0, seed,
    phase: 'countdown', phaseTime: 0, fightTime: 0,
    round: 1, score: [0, 0], winsNeeded, winner: -1, roundWinner: -1,
    players: classes.map((c, i) => createPlayer(i, c)),
    projectiles: [], zones: [], orb: null, ringRadius: C.ARENA_RADIUS,
    rounds: [],
    events: [], nextId: 1,
  };
  resetRound(state);
  return state;
}

// Advance one fixed tick (C.DT). `inputs` is [input0, input1]; missing entries count as idle.
export function step(state, inputs = []) {
  state.events = [];
  state.tick += 1;
  state.t += C.DT;
  state.phaseTime += C.DT;
  const ins = [sanitizeInput(inputs[0]), sanitizeInput(inputs[1])];

  if (state.phase === 'countdown') {
    for (let i = 0; i < 2; i++) face(state.players[i], ins[i]);
    if (state.phaseTime >= C.COUNTDOWN) {
      state.phase = 'fight';
      state.phaseTime = 0;
      emit(state, { type: 'fight', round: state.round });
    }
    return state;
  }

  if (state.phase === 'roundEnd') {
    tickProjectiles(state);
    if (state.phaseTime >= C.ROUND_END) {
      if (state.score[0] >= state.winsNeeded || state.score[1] >= state.winsNeeded) {
        state.phase = 'matchEnd';
        state.winner = state.score[0] > state.score[1] ? 0 : 1;
        emit(state, { type: 'matchEnd', winner: state.winner });
      } else {
        state.round += 1;
        resetRound(state);
        emit(state, { type: 'roundStart', round: state.round });
      }
    }
    return state;
  }

  if (state.phase !== 'fight') return state;

  state.fightTime += C.DT;
  for (let i = 0; i < 2; i++) tickPlayer(state, state.players[i], ins[i]);
  separatePlayers(state);
  tickProjectiles(state);
  tickZones(state);
  tickOrb(state);
  tickRing(state);
  checkRoundOver(state);
  return state;
}

function face(p, input) {
  const dx = input.ax - p.x, dy = input.ay - p.y;
  if (dx * dx + dy * dy > 0.01) p.facing = Math.atan2(dy, dx);
}

export function canAct(p) {
  return p.alive && p.stun <= 0 && !p.cast && !p.dash && !p.leap && p.parry <= 0;
}

// Why an ability cannot fire right now, or null if it can. Used by HUD and bot.
export function abilityBlocker(p, key) {
  const ab = CLASSES[p.cls].abilities[key];
  if (p.cd[key] > 0) return 'cooldown';
  if (p.mana < ab.cost) return 'mana';
  if (!canAct(p)) return 'busy';
  if (ab.mobility && p.root > 0) return 'rooted';
  return null;
}

function tryTrigger(state, p, key, aim) {
  if (abilityBlocker(p, key)) return false;
  const ab = CLASSES[p.cls].abilities[key];
  p.mana -= ab.cost;
  p.cd[key] = ab.cooldown;
  p.stats.casts += 1;
  emit(state, { type: 'cast', id: p.id, ability: key, windup: ab.windup, x: p.x, y: p.y, ax: aim.x, ay: aim.y });
  if (ab.windup > 0) {
    p.cast = { key, t: 0, total: ab.windup };
  } else {
    ab.release(state, p, aim);
  }
  return true;
}

function tickPlayer(state, p, input) {
  if (!p.alive) return;
  const def = CLASSES[p.cls];
  for (const k of BUTTONS) p.cd[k] = Math.max(0, p.cd[k] - C.DT);
  p.stun = Math.max(0, p.stun - C.DT);
  p.root = Math.max(0, p.root - C.DT);
  p.slowT = Math.max(0, p.slowT - C.DT);
  p.parry = Math.max(0, p.parry - C.DT);
  p.berserk = Math.max(0, p.berserk - C.DT);
  p.comboT = Math.max(0, p.comboT - C.DT);
  p.hitFlash = Math.max(0, p.hitFlash - C.DT);
  p.mana = Math.min(p.maxMana, p.mana + def.manaRegen * C.DT);

  const aim = { x: input.ax, y: input.ay };
  const px = p.x, py = p.y;

  if (p.leap) {
    const L = p.leap;
    L.t += C.DT;
    const k = Math.min(1, L.t / L.dur);
    p.x = L.sx + (L.tx - L.sx) * k;
    p.y = L.sy + (L.ty - L.sy) * k;
    p.z = Math.sin(Math.PI * k) * 2.4;
    if (k >= 1) {
      p.leap = null;
      p.z = 0;
      resolveStatic(p);
      leapLand(state, p);
    }
    recordVelocity(p, px, py);
    return;
  }

  if (p.stun <= 0) face(p, input);

  if (p.dash) {
    const D = p.dash;
    D.t += C.DT;
    p.x += D.dx * D.speed * C.DT;
    p.y += D.dy * D.speed * C.DT;
    const wall = resolveStatic(p);
    if (chargeContact(state, p) || wall || D.t >= D.dur) p.dash = null;
    recordVelocity(p, px, py);
    return;
  }

  if (p.stun <= 0) {
    if (p.cast) {
      p.cast.t += C.DT;
      if (p.cast.t >= p.cast.total) {
        const key = p.cast.key;
        p.cast = null;
        def.abilities[key].release(state, p, aim);
      }
    } else {
      for (const key of TRIGGER_ORDER) {
        if (held(input, key) && tryTrigger(state, p, key, aim)) break;
      }
    }
  }

  // Movement: instant acceleration for a snappy, arcade feel.
  let speed = def.speed;
  if (p.berserk > 0) speed *= 1.3;
  if (p.slowT > 0) speed *= 1 - p.slowAmt;
  if (p.cast) speed *= C.CAST_MOVE_MULT;
  if (p.parry > 0) speed *= C.PARRY_MOVE_MULT;
  if (p.root > 0 || p.stun > 0) speed = 0;
  p.moving = speed > 0 && (input.mx !== 0 || input.my !== 0);
  p.x += (input.mx * speed + p.kx) * C.DT;
  p.y += (input.my * speed + p.ky) * C.DT;
  const decay = Math.exp(-C.KNOCKBACK_DECAY * C.DT);
  p.kx *= decay;
  p.ky *= decay;
  if (Math.abs(p.kx) < 0.05) p.kx = 0;
  if (Math.abs(p.ky) < 0.05) p.ky = 0;
  resolveStatic(p);
  recordVelocity(p, px, py);
}

function recordVelocity(p, px, py) {
  p.vx = (p.x - px) / C.DT;
  p.vy = (p.y - py) / C.DT;
}

function separatePlayers(state) {
  const [a, b] = state.players;
  if (!a.alive || !b.alive || a.leap || b.leap) return;
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const min = C.PLAYER_RADIUS * 2;
  if (d >= min) return;
  const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
  const push = (min - d) / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
  resolveStatic(a);
  resolveStatic(b);
}

function tickProjectiles(state) {
  const keep = [];
  for (const pr of state.projectiles) {
    const x0 = pr.x, y0 = pr.y;
    pr.x += pr.vx * C.DT;
    pr.y += pr.vy * C.DT;
    pr.traveled += Math.hypot(pr.vx, pr.vy) * C.DT;
    let dead = false;

    const pillar = C.PILLARS.find((pl) => segmentHitsCircle(x0, y0, pr.x, pr.y, pl.x, pl.y, pl.r + pr.r));
    if (pillar) {
      emit(state, { type: 'projHit', id: pr.id, kind: pr.kind, x: pr.x, y: pr.y, target: -1 });
      dead = true;
    }

    if (!dead && state.phase === 'fight') {
      const target = state.players[1 - pr.owner];
      if (target.alive && !target.leap &&
          segmentHitsCircle(x0, y0, pr.x, pr.y, target.x, target.y, C.PLAYER_RADIUS + pr.r)) {
        const src = state.players[pr.owner];
        const res = dealDamage(state, src, target, pr.dmg, 'projectile');
        if (res === 'parried') {
          // Reflect: the projectile now belongs to the parrying player and flies back.
          pr.owner = target.id;
          pr.reflected = true;
          pr.traveled = 0;
          const sp = Math.hypot(pr.vx, pr.vy);
          const dx = src.x - pr.x, dy = src.y - pr.y;
          const d = Math.hypot(dx, dy) || 1;
          pr.vx = (dx / d) * sp * 1.2;
          pr.vy = (dy / d) * sp * 1.2;
          emit(state, { type: 'reflect', id: pr.id, x: pr.x, y: pr.y });
        } else {
          if (res === 'hit' && pr.root > 0) applyRoot(state, target, pr.root);
          emit(state, { type: 'projHit', id: pr.id, kind: pr.kind, x: pr.x, y: pr.y, target: target.id });
          dead = true;
        }
      }
    }

    if (!dead && (pr.traveled >= pr.range || Math.hypot(pr.x, pr.y) > C.ARENA_RADIUS + 2)) {
      emit(state, { type: 'projFade', id: pr.id, kind: pr.kind, x: pr.x, y: pr.y });
      dead = true;
    }
    if (!dead) keep.push(pr);
  }
  state.projectiles = keep;
}

function tickZones(state) {
  const keep = [];
  for (const z of state.zones) {
    z.t += C.DT;
    if (z.t < z.delay) { keep.push(z); continue; }
    emit(state, { type: 'zoneBlast', id: z.id, kind: z.kind, owner: z.owner, x: z.x, y: z.y, r: z.r });
    const target = state.players[1 - z.owner];
    if (target.alive && dist(z.x, z.y, target.x, target.y) <= z.r + C.PLAYER_RADIUS) {
      const res = dealDamage(state, state.players[z.owner], target, z.dmg, 'zone');
      if (res === 'hit' && z.slow > 0) applySlow(state, target, z.slow, z.slowDur);
    }
  }
  state.zones = keep;
}

function tickOrb(state) {
  const orb = state.orb;
  if (!orb.active) {
    if (state.fightTime >= orb.respawnAt) {
      orb.active = true;
      emit(state, { type: 'orbSpawn', x: C.ORB.x, y: C.ORB.y });
    }
    return;
  }
  for (const p of state.players) {
    if (!p.alive || p.leap) continue;
    if (dist(p.x, p.y, C.ORB.x, C.ORB.y) <= C.ORB.r + C.PLAYER_RADIUS) {
      p.hp = Math.min(p.maxHp, p.hp + C.ORB.heal);
      p.mana = Math.min(p.maxMana, p.mana + C.ORB.mana);
      orb.active = false;
      orb.respawnAt = state.fightTime + C.ORB.respawn;
      emit(state, { type: 'orbTaken', id: p.id, x: C.ORB.x, y: C.ORB.y });
      return;
    }
  }
}

export function ringRadiusAt(fightTime) {
  const k = Math.min(1, Math.max(0, (fightTime - C.RING.start) / C.RING.duration));
  return C.ARENA_RADIUS + (C.RING.minRadius - C.ARENA_RADIUS) * k;
}

function tickRing(state) {
  const prev = state.ringRadius;
  state.ringRadius = ringRadiusAt(state.fightTime);
  if (prev === C.ARENA_RADIUS && state.ringRadius < prev) emit(state, { type: 'ringStart' });
  for (const p of state.players) {
    if (!p.alive) continue;
    if (Math.hypot(p.x, p.y) > state.ringRadius) {
      p.ringAcc += C.RING.dps * C.DT;
      if (p.ringAcc >= 7) {
        p.ringAcc -= 7;
        dealDamage(state, null, p, 7, 'ring');
      }
    } else {
      p.ringAcc = 0;
    }
  }
}

function checkRoundOver(state) {
  const [a, b] = state.players;
  if (a.alive && b.alive) return;
  let winner = -1;
  if (a.alive && !b.alive) winner = 0;
  else if (b.alive && !a.alive) winner = 1;
  if (winner >= 0) state.score[winner] += 1;
  state.roundWinner = winner;
  state.rounds.push({ round: state.round, winner, duration: state.fightTime });
  state.phase = 'roundEnd';
  state.phaseTime = 0;
  emit(state, { type: 'roundEnd', winner, score: state.score.slice() });
}

export function copyPlayer(p) {
  return {
    ...p,
    cd: { ...p.cd },
    cast: p.cast && { ...p.cast },
    dash: p.dash && { ...p.dash },
    leap: p.leap && { ...p.leap },
    stats: { ...p.stats },
  };
}

// JSON-safe view of the state for the network and the renderer.
export function snapshot(state) {
  return {
    tick: state.tick, phase: state.phase, phaseTime: state.phaseTime, fightTime: state.fightTime,
    round: state.round, score: state.score, winsNeeded: state.winsNeeded, winner: state.winner,
    roundWinner: state.roundWinner, ringRadius: state.ringRadius,
    orb: state.orb,
    // Full player state: the client's predictor replays its own inputs from exactly this.
    players: state.players.map(copyPlayer),
    projectiles: state.projectiles.map((pr) => ({ id: pr.id, owner: pr.owner, kind: pr.kind, x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, r: pr.r })),
    zones: state.zones.map((z) => ({ id: z.id, owner: z.owner, kind: z.kind, x: z.x, y: z.y, r: z.r, t: z.t, delay: z.delay })),
  };
}

export { enemyOf, applySlow };
