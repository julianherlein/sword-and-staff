// App entry: menu, sessions (vs CPU, local 2P, online, attract-mode demo), main loop.
import { createMatch, step, CLASSES, constants as C } from '/services/sim/index.js';
import { createPredictor, createPacer } from '/services/sim/predict.js';
import { MSG } from '/contracts/protocol.js';
import { createBot } from '/services/ai/bot.js';
import { World } from './render/world.js';
import { CharacterView, TEAM_CSS } from './render/models.js';
import { Vfx } from './render/vfx.js';
import { Hud, ICONS, CLASS_ICONS, abilityTooltip, KEY_LABELS } from './hud.js';
import { KeyboardMouse, KeyboardP2, Gamepad, keys } from './input.js';
import { soundForEvent, unlockAudio, toggleMute, play } from './audio.js';
import { NetClient } from './net.js';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#game');
const world = new World(canvas);
const vfx = new Vfx(world, $('#floaters'));
const hud = new Hud($('#hud'), world);
// One mouse/keyboard reader for the whole app (listeners are attached once).
const kbm = new KeyboardMouse(canvas, world);

// ------------------------------------------------------------------ settings

const DEFAULTS = { mode: 'cpu', p1: 'warrior', p2: 'mage', difficulty: 'normal' };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('duel.settings') || '{}') }; } catch { /* storage blocked */ }
const saveSettings = () => { try { localStorage.setItem('duel.settings', JSON.stringify(settings)); } catch { /* ignore */ } };

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ character views

let views = [];
function ensureViews(classes) {
  if (views.length === 2 && views.every((v, i) => v.cls === classes[i])) {
    views.forEach((v) => v.reset());
    return;
  }
  views.forEach((v) => v.dispose(world.scene));
  views = classes.map((c, i) => new CharacterView(world.scene, i, c, vfx.glowTex));
}

function capture(state) {
  return {
    players: state.players.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    proj: new Map(state.projectiles.map((pr) => [pr.id, { x: pr.x, y: pr.y }])),
  };
}

// ------------------------------------------------------------------ sessions

// Shared event fan-out. `quiet` = attract mode (no sound, no HUD).
function dispatch(events, players, session) {
  for (const ev of events) {
    vfx.onEvent(ev, players, session.me ?? -1);
    if (ev.id !== undefined && views[ev.id] && (ev.type === 'swing' || ev.type === 'cast' || ev.type === 'death')) views[ev.id].onEvent(ev);
    if (ev.type === 'roundStart') { views.forEach((v) => v.reset()); vfx.clearTransient(); }
    if (session.quiet) continue;
    soundForEvent(ev);
    hud.onEvent(ev, session.names);
    if (ev.type === 'matchEnd') session.onMatchEnd && session.onMatchEnd(ev.winner);
  }
}

class LocalSession {
  constructor({ classes, controllers, names, me, quiet = false, bars = [] }) {
    this.classes = classes;
    this.state = createMatch({ classes, seed: (Math.random() * 1e9) | 0 });
    this.controllers = controllers;
    this.names = names;
    this.me = me;
    this.quiet = quiet;
    this.bars = bars;
    this.acc = 0;
    this.prev = capture(this.state);
    this.paused = false;
    ensureViews(classes);
    vfx.clearTransient();
  }

  update(dt) {
    if (!this.paused) {
      let scale = 1;
      if (vfx.hitStop > 0) { vfx.hitStop -= dt; scale = 0; } else if (vfx.slowMo > 0) { vfx.slowMo -= dt; scale = 0.3; }
      this.acc += dt * scale;
      let steps = 0;
      while (this.acc >= C.DT && steps < 5) {
        this.prev = capture(this.state);
        const s = this.state;
        const inputs = this.controllers.map((c, i) => c(s, i));
        step(s, inputs);
        dispatch(s.events, s.players, this);
        this.acc -= C.DT;
        steps++;
        if (this.quiet && s.phase === 'matchEnd') { this.restart(); break; }
      }
    }
    return { view: this.state, prev: this.prev, alpha: Math.min(1, this.acc / C.DT) };
  }

  restart() {
    this.state = createMatch({ classes: this.classes, seed: (Math.random() * 1e9) | 0 });
    this.prev = capture(this.state);
    this.acc = 0;
    ensureViews(this.classes);
    vfx.clearTransient();
  }

  destroy() {}
}

class OnlineSession {
  constructor(net, start, startSeq = 0) {
    this.net = net;
    this.me = start.you;
    this.classes = start.classes;
    this.names = start.you === 0 ? ['You', 'Opponent'] : ['Opponent', 'You'];
    kbm.setPad(true);
    this.lastView = null;
    this.latest = null; // newest raw snapshot: the local player is predicted on top of it
    // Your own character runs locally (replaying unacknowledged inputs through the shared sim);
    // the opponent is interpolated from server snapshots.
    this.predictor = createPredictor(this.me, { startSeq });
    this.pacer = createPacer();
    ensureViews(this.classes);
    vfx.clearTransient();
  }

  onSnapshot(m) {
    this.latest = m.s;
    if (m.q) this.pacer.observe(m.q[this.me]);
    const late = this.predictor.reconcile(m.s, m.ack ? m.ack[this.me] : undefined);
    if (late.length) dispatch(late, this.renderPlayers(), this);
  }

  // Server events: our own cosmetic ones play only if the prediction did not already show them.
  filterEvents(evs, snap) {
    return this.predictor.serverEvents(evs);
  }

  renderPlayers() {
    return this.latest.players.map((p, i) => (i === this.me ? this.predictor.player(p) : p));
  }

  update(dt) {
    const v = this.net.view();
    if (v) this.lastView = v;
    if (!this.lastView || !this.latest) return null;
    for (let n = this.pacer.due(dt, C.DT); n > 0; n--) {
      const me = this.predictor.player(this.latest.players[this.me]);
      const { msg, events } = this.predictor.input(kbm.sample(me, this.lastView.view.players[1 - this.me]));
      this.net.send({ t: MSG.INPUT, ...msg });
      if (events.length) dispatch(events, this.renderPlayers(), this);
    }
    this.predictor.update(dt);
    const { view, prevProj, alpha } = this.lastView;
    const players = view.players.slice();
    players[this.me] = this.predictor.player(this.latest.players[this.me]);
    return { view: { ...view, players }, prev: prevProj ? { players: null, proj: prevProj } : null, alpha };
  }

  destroy() { this.net.close(); }
}

let session = null;

function humanController(kbm) {
  return (s, i) => kbm.sample(s.players[i], s.players[1 - i]);
}
function botController(difficulty) {
  const bot = createBot({ difficulty, seed: (Math.random() * 1e9) | 0 });
  return (s, i) => bot.think(s, i);
}

function startDemo() {
  const pick = () => (Math.random() < 0.5 ? 'warrior' : 'mage');
  session = new LocalSession({
    classes: [pick(), pick()],
    controllers: [botController('hard'), botController('hard')],
    names: ['', ''], me: -1, quiet: true,
  });
  hud.hide();
}

function startLocal(mode) {
  unlockAudio();
  const classes = [settings.p1, settings.p2];
  let controllers, names, bars;
  if (mode === 'cpu') {
    kbm.setPad(true);
    controllers = [humanController(kbm), botController(settings.difficulty)];
    names = ['You', `CPU (${settings.difficulty})`];
    bars = [{ slot: 0, labels: KEY_LABELS.kbm, side: 'center' }];
  } else {
    kbm.setPad(false); // gamepads belong to player 2 in local play
    const p2 = new KeyboardP2();
    controllers = [humanController(kbm), (s, i) => p2.sample(s.players[i], s.players[1 - i])];
    names = ['Player 1', 'Player 2'];
    const padLabels = new Gamepad(0).connected || new Gamepad(1).connected;
    bars = [{ slot: 0, labels: KEY_LABELS.kbm, side: 'left' }, { slot: 1, labels: padLabels ? KEY_LABELS.pad : KEY_LABELS.p2, side: 'right' }];
  }
  session = new LocalSession({ classes, controllers, names, me: mode === 'cpu' ? 0 : -1, bars });
  session.mode = mode;
  session.onMatchEnd = (w) => showEnd(w);
  hud.setup({ classes, names, bars });
  $('#menu').classList.add('hidden');
}

function startOnline(net, start) {
  if (session && session.destroy && !(session instanceof OnlineSession)) session.destroy();
  // A rematch reuses the connection, so input sequence numbers must continue from the last match.
  const startSeq = session instanceof OnlineSession && session.net === net ? session.predictor.seq : 0;
  session = new OnlineSession(net, start, startSeq);
  session.mode = 'online';
  session.onMatchEnd = (w) => showEnd(w);
  hud.setup({ classes: start.classes, names: session.names, bars: [{ slot: start.you, labels: KEY_LABELS.kbm, side: 'center' }] });
  $('#menu').classList.add('hidden');
  $('#end').classList.add('hidden');
}

function toMenu() {
  if (session && session.destroy) session.destroy();
  $('#pause').classList.add('hidden');
  $('#end').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  startDemo();
  renderSetup();
}

// ------------------------------------------------------------------ end screen & pause

function showEnd(winner) {
  const s = session;
  const players = s instanceof OnlineSession ? s.lastView.view.players : s.state.players;
  const score = s instanceof OnlineSession ? s.lastView.view.score : s.state.score;
  let title;
  if (s.me >= 0) title = winner === s.me ? 'Victory' : 'Defeat';
  else title = `<span style="color:${TEAM_CSS[winner]}">${s.names[winner]}</span> wins`;
  $('#end-title').innerHTML = title;
  const row = (label, f) => `<tr><td>${label}</td>${players.map((p) => `<td>${f(p)}</td>`).join('')}</tr>`;
  $('#end-stats').innerHTML = `<table>
    <tr><th></th>${players.map((p, i) => `<th style="color:${TEAM_CSS[i]}">${s.names[i]} · ${CLASSES[p.cls].name}</th>`).join('')}</tr>
    ${row('Rounds won', (p) => score[p.id])}
    ${row('Damage dealt', (p) => p.stats.damage)}
    ${row('Hits landed', (p) => p.stats.hits)}
    ${row('Abilities cast', (p) => p.stats.casts)}
  </table>`;
  $('#end-note').textContent = '';
  setTimeout(() => $('#end').classList.remove('hidden'), 1200);
}

$('#rematch').addEventListener('click', () => {
  if (session instanceof OnlineSession) {
    session.net.send({ t: MSG.REMATCH });
    $('#end-note').textContent = 'Waiting for your opponent to accept...';
    return;
  }
  $('#end').classList.add('hidden');
  startLocal(session.mode);
});
$('#end-menu').addEventListener('click', toMenu);
$('#resume').addEventListener('click', () => setPaused(false));
$('#quit').addEventListener('click', toMenu);

function setPaused(on) {
  if (!session || session.quiet) return;
  if (session instanceof LocalSession) session.paused = on;
  $('#pause').classList.toggle('hidden', !on);
}

window.addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;
  if (e.code === 'Escape' && session && !session.quiet && $('#end').classList.contains('hidden')) {
    setPaused($('#pause').classList.contains('hidden'));
  }
  if (e.code === 'KeyM') toast(toggleMute() ? 'Sound off' : 'Sound on', 1000);
});
window.addEventListener('blur', () => { if (session instanceof LocalSession && !session.quiet) setPaused(true); });

// ------------------------------------------------------------------ menu

const BLURB = {
  warrior: 'Close the gap and never let go. Charge, leap and cleave. Parry their spells straight back at them.',
  mage: 'Control space and punish mistakes. Lead your shots, call lightning where they will be, blink out of reach.',
};

function classCard(cls, selected, team) {
  const d = CLASSES[cls];
  const abil = ['primary', 'secondary', 'dash', 'q', 'e', 'r']
    .map((k) => `<div class="ai">${ICONS[`${cls}.${k}`]}<div class="tip">${abilityTooltip(cls, k)}</div></div>`).join('');
  return `<button class="class-card ${selected ? 'sel' : ''}" data-cls="${cls}" style="--team:${TEAM_CSS[team]}">
    <div class="ch">${CLASS_ICONS[cls]}<b>${d.name}</b></div>
    <div class="stats"><span>HP <em>${d.hp}</em></span><span>Mana <em>${d.mana}</em></span><span>Regen <em>${d.manaRegen}/s</em></span><span>Speed <em>${d.speed}</em></span></div>
    <div class="abil">${abil}</div>
    <p>${BLURB[cls]}</p>
  </button>`;
}

function picker(slotKey, team, title, sub) {
  return `<div class="picker" data-slot="${slotKey}" style="--team:${TEAM_CSS[team]}">
    <h3><i></i>${title}<small>${sub}</small></h3>
    <div class="classes">${['warrior', 'mage'].map((c) => classCard(c, settings[slotKey] === c, team)).join('')}</div>
  </div>`;
}

let net = null;

function renderSetup() {
  const mode = settings.mode;
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const setup = $('#setup');
  if (mode === 'cpu') {
    setup.innerHTML = `
      <div class="pickers">${picker('p1', 0, 'You', 'WASD + mouse')}${picker('p2', 1, 'CPU', 'bot opponent')}</div>
      <div class="options">
        <div class="seg" id="diff">${['easy', 'normal', 'hard'].map((d) => `<button data-d="${d}" class="${settings.difficulty === d ? 'on' : ''}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}</div>
        <button class="go" id="go">Fight</button>
      </div>`;
  } else if (mode === 'local') {
    setup.innerHTML = `
      <div class="pickers">${picker('p1', 0, 'Player 1', 'WASD + mouse')}${picker('p2', 1, 'Player 2', 'arrows + J K L U I O, or gamepad')}</div>
      <div class="options"><button class="go" id="go">Fight</button></div>
      <p class="note">Player 2 on keyboard: <kbd>Arrows</kbd> move, <kbd>J</kbd> basic, <kbd>K</kbd> heavy, <kbd>L</kbd> dash, <kbd>U</kbd> <kbd>I</kbd> <kbd>O</kbd> abilities; aim locks onto Player 1.
      Plug in a gamepad for full analog aim (right stick).</p>`;
  } else {
    setup.innerHTML = `
      <div class="pickers">${picker('p1', 0, 'You', 'WASD + mouse')}</div>
      <div class="online-box" id="online-box">
        <button class="go" id="find">Find match</button>
        <span class="hint">or play a friend</span>
        <button class="btn" id="host">Host match</button>
        <input id="code" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false">
        <button class="btn" id="join">Join</button>
      </div>
      <p class="note"><b>Find match</b> pairs you with the next player who searches on <b>${location.host}</b>.
      To play a friend, one of you hosts and shares the 4-letter room code (friends on your network use the LAN address printed by <kbd>npm start</kbd>).</p>`;
  }

  setup.querySelectorAll('.picker').forEach((pk) => {
    pk.querySelectorAll('.class-card').forEach((card) => card.addEventListener('click', () => {
      settings[pk.dataset.slot] = card.dataset.cls;
      saveSettings();
      renderSetup();
    }));
  });
  setup.querySelectorAll('#diff button').forEach((b) => b.addEventListener('click', () => {
    settings.difficulty = b.dataset.d;
    saveSettings();
    renderSetup();
  }));
  const go = $('#go');
  if (go) go.addEventListener('click', () => startLocal(mode));
  const host = $('#host');
  if (host) {
    $('#find').addEventListener('click', () => onlineConnect((n) => n.send({ t: MSG.QUEUE, cls: settings.p1 })));
    host.addEventListener('click', () => onlineConnect((n) => n.send({ t: MSG.CREATE, cls: settings.p1 })));
    $('#join').addEventListener('click', () => {
      const code = $('#code').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) return toast('Enter the 4-character room code');
      onlineConnect((n) => n.send({ t: MSG.JOIN, code, cls: settings.p1 }));
    });
    $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join').click(); });
  }
}

// Waiting screen inside the online box. Cancel closes the socket, which also frees the room / queue slot.
let searchTimer = null;
function showWaiting(html) {
  $('#online-box').innerHTML = `${html}<button class="btn" id="cancel">Cancel</button>`;
  $('#cancel').addEventListener('click', () => { stopSearchTimer(); net.close(); net = null; renderSetup(); });
}
function stopSearchTimer() { clearInterval(searchTimer); searchTimer = null; }

async function onlineConnect(then) {
  unlockAudio();
  stopSearchTimer();
  if (net) net.close();
  net = new NetClient({
    created: (code) => showWaiting(`<span class="hint">Room code</span><span class="code">${code}</span><span class="hint">Waiting for an opponent...</span>`),
    queued: () => { // also sent again when a found opponent dropped before the start
      stopSearchTimer();
      const since = performance.now();
      showWaiting('<span class="spinner"></span><span class="hint">Searching for an opponent <b id="search-time">0:00</b></span>');
      searchTimer = setInterval(() => {
        const el = $('#search-time');
        if (!el) return stopSearchTimer();
        const sec = Math.floor((performance.now() - since) / 1000);
        el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      }, 250);
    },
    // Queue paired us: the server starts the match `secs` later. Count down 5..1 locally; it never
    // shows 0, since the real start is the server's 'start' message (which may arrive a bit late).
    found: (m) => {
      stopSearchTimer();
      const opp = CLASSES[m.classes[1 - m.you]].name;
      $('#online-box').innerHTML = `<div class="found"><span class="found-title">Match found</span><span class="hint">vs ${opp}</span><span class="found-count" id="found-count"></span></div>`;
      const end = performance.now() + m.secs * 1000;
      let shown = 0;
      const update = () => {
        const el = $('#found-count');
        if (!el) return stopSearchTimer();
        const n = Math.max(1, Math.ceil((end - performance.now()) / 1000));
        if (n !== shown) { shown = n; el.textContent = n; play('beep'); }
      };
      update();
      searchTimer = setInterval(update, 50);
    },
    start: (m) => { stopSearchTimer(); startOnline(net, m); },
    error: (msg) => toast(msg),
    left: (msg) => {
      if (session instanceof OnlineSession) { toast(msg); toMenu(); return; }
      if ($('#cancel')) { stopSearchTimer(); net = null; toast(msg); renderSetup(); } // dropped while waiting
    },
    snap: (m) => { if (session instanceof OnlineSession) session.onSnapshot(m); },
    events: (evs, snap) => { if (session instanceof OnlineSession) dispatch(session.filterEvents(evs, snap), snap.players, session); },
  });
  try {
    await net.connect();
    then(net);
  } catch (err) {
    toast(err.message, 4000);
  }
}

document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
  settings.mode = b.dataset.mode;
  saveSettings();
  renderSetup();
  play('beep');
}));

// ------------------------------------------------------------------ loop

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const frameOut = session && session.update(dt);
  if (frameOut) {
    const { view, prev, alpha } = frameOut;
    const positions = view.players.map((p, i) => {
      const pp = prev && prev.players && prev.players[i];
      if (!pp || !p.alive) return { x: p.x, y: p.y, z: p.z || 0 };
      return { x: pp.x + (p.x - pp.x) * alpha, y: pp.y + (p.y - pp.y) * alpha, z: (pp.z || 0) + ((p.z || 0) - (pp.z || 0)) * alpha };
    });
    view.players.forEach((p, i) => {
      if (!views[i]) return;
      views[i].update(dt, { ...p, ...positions[i] }, world.time);
      vfx.playerAmbient({ ...p, ...positions[i] }, dt);
    });
    vfx.syncProjectiles(view.projectiles, alpha, prev && prev.proj);
    vfx.syncZones(view.zones, session.me);
    vfx.update(dt, world.time, view.orb, view.ringRadius);
    if (!session.quiet) hud.update(view, dt, positions);
    const focus = { x: (positions[0].x + positions[1].x) / 2, y: (positions[0].y + positions[1].y) / 2 };
    world.update(dt, focus);
  } else {
    vfx.update(dt, world.time, null, C.ARENA_RADIUS);
    world.update(dt, null);
  }
  vfx.ambient(dt, world.time);
  world.render();
}

// Debug/automation hook: lets tests and the browser console inspect the running game.
window.__duel = { get session() { return session; }, world, vfx, keys };

startDemo();
vfx.warmup();
renderSetup();
requestAnimationFrame(frame);
