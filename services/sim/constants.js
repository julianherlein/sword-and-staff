// World units are meters. The arena floor is the sim's x/y plane.
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const ARENA_RADIUS = 13;
export const PLAYER_RADIUS = 0.5;

// Diagonal on screen once the isometric camera is yawed 45 degrees.
export const PILLARS = Object.freeze([
  { x: 7, y: 0, r: 1 },
  { x: -7, y: 0, r: 1 },
  { x: 0, y: 7, r: 1 },
  { x: 0, y: -7, r: 1 },
]);

// Left and right side of the screen.
export const SPAWNS = Object.freeze([
  { x: -6, y: 6 },
  { x: 6, y: -6 },
]);

export const COUNTDOWN = 3;
export const ROUND_END = 2.5;
export const WINS_NEEDED = 3;

// Battlerite-style center orb: contest the middle for sustain.
export const ORB = Object.freeze({ x: 0, y: 0, r: 0.9, firstSpawn: 12, respawn: 20, heal: 30, mana: 30 });

// Closing ring of fire so rounds cannot stall.
export const RING = Object.freeze({ start: 40, duration: 30, minRadius: 4, dps: 14 });

export const KNOCKBACK_DECAY = 7;
export const CAST_MOVE_MULT = 0.35;
export const PARRY_MOVE_MULT = 0.5;
