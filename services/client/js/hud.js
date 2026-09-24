// DOM HUD: player frames, ability bars with cooldown sweeps, overhead bars, banners.
import { CLASSES, constants as C } from '/services/sim/index.js';
import { TEAM_CSS } from './render/models.js';

const KEYS = ['primary', 'secondary', 'dash', 'q', 'e', 'r'];
export const KEY_LABELS = {
  kbm: { primary: 'LMB', secondary: 'RMB', dash: 'SPACE', q: 'Q', e: 'E', r: 'R' },
  p2: { primary: 'J', secondary: 'K', dash: 'L', q: 'U', e: 'I', r: 'O' },
  pad: { primary: 'RT', secondary: 'LT', dash: 'A', q: 'X', e: 'Y', r: 'B' },
};

const svg = (body, grad = '') => `<svg viewBox="0 0 64 64" aria-hidden="true"><defs>${grad}</defs>${body}</svg>`;
const lg = (id, a, b) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
const rg = (id, a, b) => `<radialGradient id="${id}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient>`;

export const ICONS = {
  'warrior.primary': svg(`<path d="M50 8 L56 14 L26 44 L20 38 Z" fill="url(#g1)"/><path d="M16 36 L28 48 L24 52 L12 40 Z" fill="#d4a64a"/><path d="M14 46 L18 50 L10 58 L6 54 Z" fill="#6b4a2a"/><path d="M8 10 Q30 6 50 30" stroke="#fff" stroke-width="2" fill="none" opacity=".6"/>`, lg('g1', '#ffffff', '#8c96a8')),
  'warrior.secondary': svg(`<path d="M10 54 L40 24" stroke="#6b4a2a" stroke-width="5" stroke-linecap="round"/><path d="M34 10 Q58 12 56 34 Q46 26 36 30 Q38 20 34 10Z" fill="url(#g2)"/><path d="M6 30 Q20 8 46 6" stroke="#ffb060" stroke-width="3" fill="none"/><path d="M4 40 Q16 16 44 12" stroke="#ffb060" stroke-width="2" fill="none" opacity=".6"/>`, lg('g2', '#ffffff', '#7b8494')),
  'warrior.dash': svg(`<path d="M20 32 L44 14 L44 24 L58 32 L44 40 L44 50 Z" fill="url(#g3)"/><path d="M4 22 H18 M2 32 H16 M4 42 H18" stroke="#ffd8a0" stroke-width="4" stroke-linecap="round"/>`, lg('g3', '#ffe2a8', '#d98a2b')),
  'warrior.q': svg(`<path d="M32 6 L54 14 Q54 42 32 58 Q10 42 10 14 Z" fill="url(#g4)" stroke="#ffd36a" stroke-width="3"/><path d="M32 14 V50 M18 26 H46" stroke="#ffd36a" stroke-width="4"/>`, lg('g4', '#4a6fb8', '#1c2a4a')),
  'warrior.e': svg(`<path d="M8 50 Q32 -6 56 50" stroke="#ffd8a0" stroke-width="4" fill="none" stroke-dasharray="6 4"/><path d="M50 40 L58 52 L44 52 Z" fill="#ffd8a0"/><ellipse cx="50" cy="56" rx="12" ry="3" fill="#ffb060" opacity=".7"/><circle cx="32" cy="20" r="6" fill="url(#g5)"/>`, lg('g5', '#ffffff', '#b8bcc4')),
  'warrior.r': svg(`<path d="M32 4 Q44 20 40 30 Q50 24 50 14 Q62 34 48 50 Q40 60 32 60 Q24 60 16 50 Q2 34 14 14 Q14 24 24 30 Q20 20 32 4Z" fill="url(#g6)"/><path d="M24 40 L30 44 M40 40 L34 44 M26 50 Q32 46 38 50" stroke="#300" stroke-width="3" fill="none"/>`, lg('g6', '#ffcc40', '#c01a08')),
  'mage.primary': svg(`<circle cx="40" cy="24" r="14" fill="url(#m1)"/><path d="M30 34 Q16 44 6 58 Q20 50 34 38Z M26 28 Q14 32 4 40 Q18 38 28 32Z M36 38 Q30 50 24 60 Q34 52 40 40Z" fill="#ff7a2a" opacity=".8"/>`, rg('m1', '#fff6c0', '#ff5a10')),
  'mage.secondary': svg(`<path d="M38 2 L16 34 H30 L22 62 L50 24 H34 L44 2Z" fill="url(#m2)" stroke="#fff" stroke-width="1.5"/>`, lg('m2', '#ffffff', '#5cc8ff')),
  'mage.dash': svg(`<circle cx="20" cy="42" r="10" fill="none" stroke="#c77dff" stroke-width="3" stroke-dasharray="4 3"/><circle cx="44" cy="20" r="10" fill="url(#m3)"/><path d="M26 36 L38 26" stroke="#e0b0ff" stroke-width="3" stroke-dasharray="3 3"/><path d="M44 6 L46 14 M58 20 L50 20 M44 34 L44 30" stroke="#fff" stroke-width="2"/>`, rg('m3', '#ffffff', '#9b4dff')),
  'mage.q': svg(`<circle cx="32" cy="32" r="14" fill="url(#m4)"/><circle cx="32" cy="32" r="24" fill="none" stroke="#c77dff" stroke-width="3" stroke-dasharray="8 5"/><path d="M14 14 L50 50 M50 14 L14 50" stroke="#e0b0ff" stroke-width="2" opacity=".6"/>`, rg('m4', '#ffffff', '#8a2be2')),
  'mage.e': svg(`<g stroke="url(#m5)" stroke-width="4" stroke-linecap="round"><path d="M32 4 V60 M8 18 L56 46 M8 46 L56 18"/><path d="M26 8 L32 14 L38 8 M26 56 L32 50 L38 56 M6 26 L14 24 L10 16 M58 38 L50 40 L54 48 M6 38 L14 40 L10 48 M58 26 L50 24 L54 16" stroke-width="2.5"/></g>`, lg('m5', '#ffffff', '#6cc4ff')),
  'mage.r': svg(`<circle cx="42" cy="22" r="12" fill="url(#m6)"/><path d="M34 30 L6 58 M38 34 L16 60 M30 26 L4 48" stroke="#ff7a2a" stroke-width="4" stroke-linecap="round" opacity=".85"/><ellipse cx="42" cy="22" rx="16" ry="16" fill="none" stroke="#ffcc60" stroke-width="1.5" opacity=".6"/>`, rg('m6', '#ffe08a', '#b01a00')),
};

export const CLASS_ICONS = {
  warrior: ICONS['warrior.primary'],
  mage: svg(`<path d="M32 4 L44 40 H20 Z" fill="url(#c1)"/><rect x="12" y="40" width="40" height="5" rx="2" fill="#d9c38a"/><circle cx="32" cy="52" r="8" fill="#e0b48f"/>`, lg('c1', '#9b7dff', '#3a1f7a')),
};

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export function abilityTooltip(cls, key) {
  const ab = CLASSES[cls].abilities[key];
  const stats = [];
  if (ab.dmg) stats.push(`${ab.dmg} dmg`);
  if (ab.cost) stats.push(`${ab.cost} mana`);
  stats.push(`${ab.cooldown}s cd`);
  if (ab.windup) stats.push(`${ab.windup}s cast`);
  return `<b>${ab.name}</b><span>${stats.join(' · ')}</span><p>${ab.desc}</p>`;
}

class AbilityBar {
  constructor(parent, cls, labels, side) {
    this.cls = cls;
    this.root = el('div', `abilities ${side}`);
    this.slots = {};
    for (const k of KEYS) {
      const ab = CLASSES[cls].abilities[k];
      const s = el('div', 'slot');
      s.innerHTML = `<div class="icon">${ICONS[`${cls}.${k}`]}</div><div class="cd"></div><div class="cdtext"></div>
        <div class="key">${labels[k]}</div>${ab.cost ? `<div class="cost">${ab.cost}</div>` : ''}
        <div class="tip">${abilityTooltip(cls, k)}</div>`;
      this.root.appendChild(s);
      this.slots[k] = { el: s, cd: s.querySelector('.cd'), text: s.querySelector('.cdtext'), last: 0 };
    }
    parent.appendChild(this.root);
  }

  update(p) {
    for (const k of KEYS) {
      const ab = CLASSES[this.cls].abilities[k];
      const s = this.slots[k];
      const cd = p.cd[k];
      const frac = ab.cooldown > 0 ? cd / ab.cooldown : 0;
      s.cd.style.setProperty('--p', `${(frac * 360).toFixed(1)}deg`);
      s.text.textContent = cd > 0.05 && ab.cooldown >= 1 ? (cd >= 1 ? Math.ceil(cd) : cd.toFixed(1)) : '';
      s.el.classList.toggle('nomana', p.mana < ab.cost);
      s.el.classList.toggle('active', !!(p.cast && p.cast.key === k));
      if (s.last > 0 && cd === 0) { // ready pulse
        s.el.classList.remove('ready');
        void s.el.offsetWidth;
        s.el.classList.add('ready');
      }
      s.last = cd;
    }
  }

  destroy() { this.root.remove(); }
}

class PlayerFrame {
  constructor(parent, slot, cls, name) {
    this.root = el('div', `frame f${slot}`);
    this.root.style.setProperty('--team', TEAM_CSS[slot]);
    this.root.innerHTML = `
      <div class="portrait">${CLASS_ICONS[cls]}</div>
      <div class="bars">
        <div class="name"><span>${name}</span><em>${CLASSES[cls].name}</em></div>
        <div class="bar hp"><div class="ghost"></div><div class="fill"></div><span></span></div>
        <div class="bar mp"><div class="fill"></div><span></span></div>
        <div class="status"></div>
      </div>
      <div class="pips"></div>`;
    parent.appendChild(this.root);
    this.hpFill = this.root.querySelector('.hp .fill');
    this.hpGhost = this.root.querySelector('.hp .ghost');
    this.hpText = this.root.querySelector('.hp span');
    this.mpFill = this.root.querySelector('.mp .fill');
    this.mpText = this.root.querySelector('.mp span');
    this.status = this.root.querySelector('.status');
    this.pips = this.root.querySelector('.pips');
    this.ghost = 1;
    this.lastScore = -1;
  }

  update(p, score, winsNeeded, dt) {
    const hp = Math.max(0, p.hp / p.maxHp);
    this.ghost = hp > this.ghost ? hp : this.ghost + (hp - this.ghost) * Math.min(1, dt * 2.5);
    this.hpFill.style.width = `${hp * 100}%`;
    this.hpGhost.style.width = `${this.ghost * 100}%`;
    this.hpText.textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;
    this.mpFill.style.width = `${(p.mana / p.maxMana) * 100}%`;
    this.mpText.textContent = `${Math.floor(p.mana)}`;
    this.root.classList.toggle('low', hp < 0.3 && p.alive);
    const st = [];
    if (p.stun > 0) st.push('<i class="s-stun">STUN</i>');
    if (p.root > 0) st.push('<i class="s-root">ROOT</i>');
    if (p.slowT > 0) st.push('<i class="s-slow">SLOW</i>');
    if (p.berserk > 0) st.push('<i class="s-berserk">BERSERK</i>');
    if (p.parry > 0) st.push('<i class="s-parry">PARRY</i>');
    const html = st.join('');
    if (html !== this.status.innerHTML) this.status.innerHTML = html;
    if (score !== this.lastScore) {
      this.pips.innerHTML = Array.from({ length: winsNeeded }, (_, i) => `<b class="${i < score ? 'on' : ''}"></b>`).join('');
      this.lastScore = score;
    }
  }
}

export class Hud {
  constructor(root, world) {
    this.root = root;
    this.world = world;
    this.top = root.querySelector('#hud-top');
    this.bottom = root.querySelector('#hud-bottom');
    this.overheadLayer = root.querySelector('#overheads');
    this.banner = root.querySelector('#banner');
    this.centerInfo = root.querySelector('#center-info');
    this.frames = [];
    this.bars = [];
    this.overheads = [];
    this.bannerUntil = 0;
    this.lastCount = -1;
  }

  setup({ classes, names, bars }) {
    this.teardown();
    this.frames = classes.map((c, i) => new PlayerFrame(this.top, i, c, names[i]));
    // Frames sit on both sides of the center info.
    this.top.insertBefore(this.frames[0].root, this.centerInfo);
    this.bars = bars.map(({ slot, labels, side }) => ({ slot, bar: new AbilityBar(this.bottom, classes[slot], labels, side) }));
    this.overheads = classes.map((c, i) => {
      const o = el('div', `overhead o${i}`);
      o.style.setProperty('--team', TEAM_CSS[i]);
      o.innerHTML = `<div class="ohp"><div></div></div><div class="omp"><div></div></div><div class="ocast"><div></div></div>`;
      this.overheadLayer.appendChild(o);
      return { el: o, hp: o.querySelector('.ohp div'), mp: o.querySelector('.omp div'), cast: o.querySelector('.ocast'), castFill: o.querySelector('.ocast div') };
    });
    this.root.classList.remove('hidden');
  }

  teardown() {
    for (const f of this.frames) f.root.remove();
    for (const b of this.bars) b.bar.destroy();
    for (const o of this.overheads) o.el.remove();
    this.frames = []; this.bars = []; this.overheads = [];
    this.banner.className = '';
    this.banner.textContent = '';
  }

  hide() { this.root.classList.add('hidden'); }

  showBanner(text, cls = '', ms = 1200) {
    this.banner.innerHTML = text;
    this.banner.className = '';
    void this.banner.offsetWidth;
    this.banner.className = `show ${cls}`;
    this.bannerUntil = performance.now() + ms;
  }

  onEvent(ev, names) {
    if (ev.type === 'fight') this.showBanner('FIGHT!', 'fight', 900);
    else if (ev.type === 'roundEnd') {
      const w = ev.winner;
      this.showBanner(w < 0 ? 'DRAW' : `<span style="color:${TEAM_CSS[w]}">${names[w]}</span> wins the round`, 'round', 2200);
    } else if (ev.type === 'ringStart') this.showBanner('The ring of fire closes in!', 'warn', 1800);
  }

  update(view, dt, positions) {
    const now = performance.now();
    if (this.banner.classList.contains('show') && now > this.bannerUntil) this.banner.classList.remove('show');

    if (view.phase === 'countdown') {
      const n = Math.ceil(C.COUNTDOWN - view.phaseTime);
      if (n !== this.lastCount && n > 0) {
        this.showBanner(n === 3 ? `<small>Round ${view.round}</small>${n}` : `${n}`, 'count', 900);
        this.lastCount = n;
      }
    } else {
      this.lastCount = -1;
    }

    const t = view.fightTime;
    const ringIn = C.RING.start - t;
    this.centerInfo.innerHTML = `<div class="round-no">ROUND ${view.round}</div>
      <div class="clock">${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}</div>
      ${view.phase === 'fight' && ringIn > 0 && ringIn < 10 ? `<div class="ringwarn">Ring closes in ${Math.ceil(ringIn)}</div>` : ''}
      ${view.phase === 'fight' && ringIn <= 0 ? '<div class="ringwarn on">Ring of fire</div>' : ''}`;

    view.players.forEach((p, i) => {
      this.frames[i].update(p, view.score[i], view.winsNeeded, dt);
      const o = this.overheads[i];
      const pos = positions[i];
      const s = this.world.worldToScreen(pos.x, pos.y, 2.9 + (p.z || 0));
      o.el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      o.el.style.opacity = p.alive ? 1 : 0;
      o.hp.style.width = `${(p.hp / p.maxHp) * 100}%`;
      o.mp.style.width = `${(p.mana / p.maxMana) * 100}%`;
      o.cast.style.visibility = p.cast ? 'visible' : 'hidden';
      if (p.cast) o.castFill.style.width = `${Math.min(100, (p.cast.t / p.cast.total) * 100)}%`;
    });
    for (const b of this.bars) b.bar.update(view.players[b.slot]);
  }
}
