// Input devices -> contract inputs ({mx, my, ax, ay, b}).
// Movement keys are screen-relative (W = up on screen), converted to world space here.
import { BUTTON_BIT } from '/contracts/protocol.js';
import { SCREEN_RIGHT, SCREEN_UP } from './render/world.js';

export function screenToMove(ix, iy) {
  let mx = ix * SCREEN_RIGHT.x + iy * SCREEN_UP.x;
  let my = ix * SCREEN_RIGHT.y + iy * SCREEN_UP.y;
  const d = Math.hypot(mx, my);
  if (d > 1) { mx /= d; my /= d; }
  return { mx, my };
}

// Global key tracker. `latched` remembers taps shorter than one sample so no press is lost.
class Keys {
  constructor() {
    this.down = new Set();
    this.latched = new Set();
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.latched.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  held(code) {
    return this.down.has(code) || this.latched.has(code);
  }

  consume(codes) {
    for (const c of codes) this.latched.delete(c);
  }
}

export const keys = new Keys();

export const P1_KEYS = {
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  dash: ['Space', 'ShiftLeft'], q: ['KeyQ'], e: ['KeyE'], r: ['KeyR'],
  // primary/secondary come from the mouse; keyboard fallbacks for trackpads:
  primary: ['KeyF'], secondary: ['KeyG'],
};

export const P2_KEYS = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  primary: ['KeyJ', 'Numpad1'], secondary: ['KeyK', 'Numpad2'], dash: ['KeyL', 'Numpad3'],
  q: ['KeyU', 'Numpad4'], e: ['KeyI', 'Numpad5'], r: ['KeyO', 'Numpad6'],
};

function keyButtons(map) {
  let b = 0;
  for (const k of ['primary', 'secondary', 'dash', 'q', 'e', 'r']) {
    if (map[k] && map[k].some((c) => keys.held(c))) b |= BUTTON_BIT[k];
  }
  return b;
}

function keyMove(map) {
  const ix = (map.right.some((c) => keys.held(c)) ? 1 : 0) - (map.left.some((c) => keys.held(c)) ? 1 : 0);
  const iy = (map.up.some((c) => keys.held(c)) ? 1 : 0) - (map.down.some((c) => keys.held(c)) ? 1 : 0);
  return screenToMove(ix, iy);
}

function allCodes(map) {
  return Object.values(map).flat();
}

// Player 1: WASD + mouse aim. Also takes over a gamepad if one is being used.
export class KeyboardMouse {
  constructor(canvas, world, { usePad = true } = {}) {
    this.world = world;
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.buttons = 0;
    this.latched = 0;
    this.lastMouseMove = performance.now();
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.lastMouseMove = performance.now(); });
    canvas.addEventListener('mousedown', (e) => {
      const bit = e.button === 0 ? BUTTON_BIT.primary : e.button === 2 ? BUTTON_BIT.secondary : 0;
      this.buttons |= bit;
      this.latched |= bit;
    });
    window.addEventListener('mouseup', (e) => {
      const bit = e.button === 0 ? BUTTON_BIT.primary : e.button === 2 ? BUTTON_BIT.secondary : 0;
      this.buttons &= ~bit;
    });
    window.addEventListener('blur', () => { this.buttons = 0; });
    this.pad = usePad ? new Gamepad(0) : null; // local 2P hands gamepad 0 to player 2
  }

  setPad(on) {
    this.pad = on ? new Gamepad(0) : null;
  }

  aimPoint() {
    return this.world.screenToGround(this.mouse.x, this.mouse.y);
  }

  sample(me, foe) {
    const padInput = this.pad && this.pad.sample(me, foe);
    if (padInput && this.pad.lastActive > this.lastMouseMove) return padInput;
    const { mx, my } = keyMove(P1_KEYS);
    const aim = this.aimPoint();
    const b = keyButtons(P1_KEYS) | this.buttons | this.latched;
    this.latched = 0;
    keys.consume(allCodes(P1_KEYS));
    return { mx, my, ax: aim.x, ay: aim.y, b };
  }
}

// Player 2 on the same keyboard: arrows + J K L U I O. No mouse, so aim locks onto the opponent.
export class KeyboardP2 {
  constructor() {
    this.pad = new Gamepad(1);
    this.pad0 = new Gamepad(0);
  }

  sample(me, foe) {
    // A connected gamepad always wins for player 2.
    const pad = this.pad.sample(me, foe) || this.pad0.sample(me, foe, true);
    if (pad) return pad;
    const { mx, my } = keyMove(P2_KEYS);
    const b = keyButtons(P2_KEYS);
    keys.consume(allCodes(P2_KEYS));
    return { mx, my, ax: foe ? foe.x : 0, ay: foe ? foe.y : 0, b };
  }
}

// Standard-mapping gamepad. Left stick moves, right stick aims (8m reach), no stick = aim at foe.
export class Gamepad {
  constructor(index) {
    this.index = index;
    this.lastActive = 0;
  }

  get connected() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return !!pads[this.index];
  }

  sample(me, foe, requireActivity = false) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[this.index];
    if (!gp || !me) return null;
    const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0);
    const rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
    const btn = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4));
    let b = 0;
    if (btn(7)) b |= BUTTON_BIT.primary; // RT
    if (btn(6)) b |= BUTTON_BIT.secondary; // LT
    if (btn(0) || btn(5)) b |= BUTTON_BIT.dash; // A / RB
    if (btn(2) || btn(4)) b |= BUTTON_BIT.q; // X / LB
    if (btn(3)) b |= BUTTON_BIT.e; // Y
    if (btn(1)) b |= BUTTON_BIT.r; // B
    const active = lx || ly || rx || ry || b;
    if (active) this.lastActive = performance.now();
    if (requireActivity && performance.now() - this.lastActive > 5000) return null;
    const { mx, my } = screenToMove(lx, -ly);
    let ax, ay;
    if (rx || ry) {
      const a = screenToMove(rx, -ry);
      const mag = Math.min(1, Math.hypot(rx, ry));
      ax = me.x + (a.mx / (Math.hypot(a.mx, a.my) || 1)) * 8 * mag;
      ay = me.y + (a.my / (Math.hypot(a.mx, a.my) || 1)) * 8 * mag;
    } else {
      ax = foe ? foe.x : me.x + Math.cos(me.facing);
      ay = foe ? foe.y : me.y + Math.sin(me.facing);
    }
    return { mx, my, ax, ay, b };
  }
}
