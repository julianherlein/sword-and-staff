// Touch controls for phones and tablets: a floating joystick on the left half of the screen and
// the six ability buttons on the right. Everything maps to the same contract input as the keyboard
// ({mx, my, ax, ay, b}), so the sim and the netcode do not know the difference.
//
// Ability buttons:
//   tap                 cast, aimed at the enemy
//   drag, then release  cast toward the drag (ground spells land at the drag distance)
//   drag back onto the button and release   cancel
//   basic attack        fires for as long as it is held (like holding the mouse button)
import { BUTTON_BIT } from '/contracts/protocol.js';
import { CLASSES, abilityBlocker } from '/services/sim/index.js';
import { screenToMove } from './input.js';
import { ICONS } from './hud.js';

const KEYS = ['primary', 'secondary', 'dash', 'q', 'e', 'r'];
const STICK_RADIUS = 56; // px of thumb travel for full speed
const DRAG_START = 16; // px before a press becomes an aimed drag
const AIM_DRAG = 110; // px of drag for full range
const PENDING_MS = 300; // a release waits this long for the ability to become usable (e.g. mid-cast)
const HOLD_AIM_MS = 900; // a released aim stays put this long, so wind-ups keep the chosen spot

// Phones and tablets: the primary pointer is a finger. Touchscreen laptops have a mouse as primary
// pointer and keep mouse controls (the overlay would otherwise sit over the canvas and eat clicks).
export const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;

export class TouchControls {
  // `root`: the #touch overlay. `world`: for projecting the aim reticle. `actions`: {pause, chat}.
  constructor(root, world, actions) {
    this.root = root;
    this.world = world;
    this.actions = actions;
    this.lastUsed = 0; // performance.now() of the last touch; KeyboardMouse prefers whichever was used last
    this.stick = null; // {id, ox, oy, x, y}
    this.press = new Map(); // pointerId -> {key, ox, oy, x, y, dragged}
    this.pending = new Map(); // key -> expiry time
    this.held = 0; // bits held right now (basic attack)
    this.aim = null; // {x, y, until}: fixed aim point after an aimed release
    this.me = null; // latest local player view, for aim origin and cooldowns
    this.cls = null;

    root.innerHTML = `
      <div class="t-stick"><div class="t-knob"></div></div>
      <div class="t-buttons">${KEYS.map((k) => `<button class="t-btn t-${k}" data-key="${k}"><div class="icon"></div><div class="cd"></div><div class="cdtext"></div></button>`).join('')}</div>
      <div class="t-top"><button class="t-pause" aria-label="Menu">II</button><button class="t-chat" aria-label="Chat">Chat</button></div>
      <div class="t-reticle"></div>`;
    this.stickEl = root.querySelector('.t-stick');
    this.knob = root.querySelector('.t-knob');
    this.reticle = root.querySelector('.t-reticle');
    this.buttons = Object.fromEntries(KEYS.map((k) => {
      const el = root.querySelector(`.t-${k}`);
      return [k, { el, icon: el.querySelector('.icon'), cd: el.querySelector('.cd'), text: el.querySelector('.cdtext') }];
    }));

    // Joystick: anywhere on the left part of the screen (the overlay itself receives it).
    root.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e, true));
    root.querySelector('.t-pause').addEventListener('click', () => this.actions.pause());
    root.querySelector('.t-chat').addEventListener('click', () => this.actions.chat());
    window.addEventListener('blur', () => this.reset());
  }

  // Show for a class (the local player's), or hide with null. `chat`: show the chat button.
  show(cls, { chat = false } = {}) {
    this.reset();
    this.cls = cls;
    if (!cls) { this.root.classList.add('hidden'); document.body.classList.remove('touch-play'); return; }
    for (const k of KEYS) this.buttons[k].icon.innerHTML = ICONS[`${cls}.${k}`];
    this.root.querySelector('.t-chat').classList.toggle('hidden', !chat);
    this.root.classList.remove('hidden');
    document.body.classList.add('touch-play');
  }

  get active() { return !!this.cls; }

  reset() {
    this.stick = null;
    this.press.clear();
    this.pending.clear();
    this.held = 0;
    this.aim = null;
    this.stickEl.classList.remove('on');
    for (const k of KEYS) this.buttons[k].el.classList.remove('down', 'aiming', 'cancel');
    this.reticle.classList.remove('on');
  }

  onDown(e) {
    if (!this.active || e.pointerType === 'mouse') return;
    // Stops the browser's emulated mouse events, which would steal control back to the mouse and
    // fire a basic attack. Clicks (menu and chat buttons) still happen.
    e.preventDefault();
    const btn = e.target.closest('.t-btn');
    if (btn) {
      const key = btn.dataset.key;
      this.press.set(e.pointerId, { key, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY, dragged: false });
      this.buttons[key].el.classList.add('down');
      if (key === 'primary') this.held |= BUTTON_BIT.primary;
    } else if (!e.target.closest('button') && e.clientX < window.innerWidth * 0.5 && !this.stick) {
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      this.stickEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.knob.style.transform = 'translate(0px, 0px)';
      this.stickEl.classList.add('on');
    } else return;
    this.lastUsed = performance.now();
  }

  onMove(e) {
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick.x = e.clientX;
      this.stick.y = e.clientY;
      const { dx, dy } = this.stickVector();
      this.knob.style.transform = `translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
      this.lastUsed = performance.now();
      return;
    }
    const p = this.press.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const d = Math.hypot(p.x - p.ox, p.y - p.oy);
    if (d > DRAG_START) p.dragged = true;
    const b = this.buttons[p.key];
    b.el.classList.toggle('aiming', p.dragged);
    b.el.classList.toggle('cancel', p.dragged && this.overButton(p));
    this.lastUsed = performance.now();
  }

  onUp(e, cancelled = false) {
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick = null;
      this.stickEl.classList.remove('on');
      return;
    }
    const p = this.press.get(e.pointerId);
    if (!p) return;
    this.press.delete(e.pointerId);
    this.buttons[p.key].el.classList.remove('down', 'aiming', 'cancel');
    if (p.key === 'primary') this.held &= ~BUTTON_BIT.primary;
    if (cancelled || (p.dragged && this.overButton(p))) return; // dragged back onto the button: cancel
    if (p.dragged) {
      const at = this.dragAim(p);
      if (at) this.aim = { ...at, until: performance.now() + HOLD_AIM_MS };
    } else {
      this.aim = null; // tap: aim at the enemy
    }
    if (p.key !== 'primary') this.pending.set(p.key, performance.now() + PENDING_MS);
  }

  overButton(p) {
    const r = this.buttons[p.key].el.getBoundingClientRect();
    return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  }

  stickVector() {
    const s = this.stick;
    let dx = (s.x - s.ox) / STICK_RADIUS, dy = (s.y - s.oy) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    return { dx, dy };
  }

  // Ground point for a drag from an ability button: the drag's screen direction, scaled to range.
  dragAim(p) {
    if (!this.me) return null;
    const dx = p.x - p.ox, dy = p.y - p.oy;
    const len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const dir = screenToMove(dx / len, -dy / len);
    const n = Math.hypot(dir.mx, dir.my) || 1;
    const ab = CLASSES[this.cls].abilities[p.key];
    const reach = (ab.range || 7) * Math.min(1, len / AIM_DRAG);
    return { x: this.me.x + (dir.mx / n) * Math.max(0.5, reach), y: this.me.y + (dir.my / n) * Math.max(0.5, reach) };
  }

  sample(me, foe) {
    this.me = me;
    const now = performance.now();
    let mx = 0, my = 0;
    if (this.stick) {
      const { dx, dy } = this.stickVector();
      ({ mx, my } = screenToMove(dx, -dy));
    }
    // Aim: an active drag, else a recently released aim, else the enemy.
    let aim = null;
    for (const p of this.press.values()) if (p.dragged && !this.overButton(p)) aim = this.dragAim(p);
    if (!aim && this.aim && now < this.aim.until) aim = this.aim;
    if (!aim) aim = foe ? { x: foe.x, y: foe.y } : { x: me.x + Math.cos(me.facing), y: me.y + Math.sin(me.facing) };
    // Released abilities: pressed until they fire, or until they cannot (cooldown, mana) or time out.
    let b = this.held;
    for (const [key, until] of this.pending) {
      const why = me ? abilityBlocker(me, key) : null;
      if (now > until || why === 'cooldown' || why === 'mana') { this.pending.delete(key); continue; }
      b |= BUTTON_BIT[key];
      if (!why) this.pending.delete(key); // usable now: this tick casts it
    }
    return { mx, my, ax: aim.x, ay: aim.y, b };
  }

  // Per frame: cooldown sweeps and the aim reticle. `me` = the local player as rendered.
  update(me) {
    if (!this.active || !me) return;
    this.me = me;
    for (const k of KEYS) {
      const ab = CLASSES[this.cls].abilities[k];
      const b = this.buttons[k];
      const cd = me.cd[k];
      b.cd.style.setProperty('--p', `${((ab.cooldown > 0 ? cd / ab.cooldown : 0) * 360).toFixed(1)}deg`);
      b.text.textContent = cd > 0.05 && ab.cooldown >= 1 ? (cd >= 1 ? Math.ceil(cd) : cd.toFixed(1)) : '';
      b.el.classList.toggle('nomana', me.mana < ab.cost);
    }
    let aim = null;
    for (const p of this.press.values()) if (p.dragged && !this.overButton(p)) aim = this.dragAim(p);
    this.reticle.classList.toggle('on', !!aim);
    if (aim) {
      const s = this.world.worldToScreen(aim.x, aim.y);
      this.reticle.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
  }
}
