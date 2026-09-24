// Synthesized sound effects (WebAudio). No asset files: every sound is built from oscillators and noise.
let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem('duel.muted') === '1'; } catch { /* storage blocked */ }

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.55;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

export function unlockAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume();
}

export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('duel.muted', muted ? '1' : '0'); } catch { /* ignore */ }
  if (master) master.gain.value = muted ? 0 : 0.55;
  return muted;
}

export const isMuted = () => muted;

function env(gain, t, a, d, peak) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + a);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function noise({ dur = 0.2, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, vol = 0.5, attack = 0.005, delay = 0 }) {
  const c = ensure(); if (!c) return;
  const t = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const filt = c.createBiquadFilter();
  filt.type = type;
  filt.Q.value = q;
  filt.frequency.setValueAtTime(f0, t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = c.createGain();
  env(g, t, attack, dur, vol);
  src.connect(filt); filt.connect(g); g.connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + attack + 0.05);
}

function tone({ dur = 0.2, type = 'sine', f0 = 440, f1 = f0, vol = 0.3, attack = 0.005, delay = 0 }) {
  const c = ensure(); if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = c.createGain();
  env(g, t, attack, dur, vol);
  o.connect(g); g.connect(master);
  o.start(t);
  o.stop(t + dur + attack + 0.05);
}

const SOUNDS = {
  swing: () => noise({ dur: 0.14, f0: 600, f1: 2600, q: 1.5, vol: 0.35, attack: 0.02 }),
  heavySwing: () => { noise({ dur: 0.25, f0: 300, f1: 1400, q: 1.2, vol: 0.5, attack: 0.04 }); },
  hit: () => { tone({ dur: 0.12, f0: 180, f1: 60, vol: 0.5 }); noise({ dur: 0.06, f0: 2500, q: 0.8, vol: 0.3 }); },
  heavyHit: () => { tone({ dur: 0.25, f0: 140, f1: 40, vol: 0.7 }); noise({ dur: 0.15, type: 'lowpass', f0: 3000, f1: 300, vol: 0.5 }); },
  firebolt: () => { noise({ dur: 0.25, f0: 400, f1: 1800, q: 2, vol: 0.3 }); tone({ dur: 0.15, type: 'triangle', f0: 300, f1: 700, vol: 0.12 }); },
  paralyze: () => { tone({ dur: 0.35, type: 'sawtooth', f0: 220, f1: 110, vol: 0.12 }); tone({ dur: 0.35, type: 'sine', f0: 880, f1: 440, vol: 0.12 }); },
  charge: () => noise({ dur: 0.3, type: 'lowpass', f0: 800, f1: 200, vol: 0.45 }),
  lightningCast: () => tone({ dur: 0.5, type: 'sawtooth', f0: 80, f1: 400, vol: 0.06, attack: 0.1 }),
  lightning: () => { noise({ dur: 0.45, type: 'highpass', f0: 5000, f1: 1500, vol: 0.6, attack: 0.001 }); tone({ dur: 0.6, f0: 90, f1: 35, vol: 0.6, delay: 0.02 }); },
  meteorCast: () => tone({ dur: 1.2, type: 'sawtooth', f0: 60, f1: 30, vol: 0.12, attack: 0.3 }),
  explosion: () => { noise({ dur: 1.0, type: 'lowpass', f0: 2500, f1: 60, vol: 0.9, attack: 0.002 }); tone({ dur: 0.8, f0: 70, f1: 25, vol: 0.8 }); },
  blink: () => { tone({ dur: 0.2, type: 'sine', f0: 400, f1: 1600, vol: 0.2 }); noise({ dur: 0.15, f0: 3000, q: 4, vol: 0.15 }); },
  nova: () => { noise({ dur: 0.5, type: 'highpass', f0: 6000, f1: 2000, vol: 0.45 }); tone({ dur: 0.4, type: 'triangle', f0: 1200, f1: 600, vol: 0.12 }); },
  parry: () => { for (const f of [1400, 2100, 2800]) tone({ dur: 0.4, type: 'triangle', f0: f, f1: f * 0.98, vol: 0.12 }); },
  parryUp: () => tone({ dur: 0.15, type: 'square', f0: 500, f1: 900, vol: 0.06 }),
  leap: () => noise({ dur: 0.3, f0: 300, f1: 1200, q: 1, vol: 0.3, attack: 0.05 }),
  land: () => { tone({ dur: 0.3, f0: 110, f1: 40, vol: 0.7 }); noise({ dur: 0.3, type: 'lowpass', f0: 1500, f1: 100, vol: 0.5 }); },
  berserk: () => { tone({ dur: 0.6, type: 'sawtooth', f0: 110, f1: 55, vol: 0.2 }); noise({ dur: 0.5, type: 'lowpass', f0: 600, f1: 200, vol: 0.4 }); },
  orb: () => { for (const [i, f] of [523, 659, 784, 1046].entries()) tone({ dur: 0.25, f0: f, vol: 0.12, delay: i * 0.06 }); },
  death: () => { tone({ dur: 1.2, type: 'sawtooth', f0: 200, f1: 40, vol: 0.25 }); noise({ dur: 0.8, type: 'lowpass', f0: 1000, f1: 80, vol: 0.5 }); },
  beep: () => tone({ dur: 0.12, type: 'square', f0: 660, vol: 0.08 }),
  gong: () => { for (const f of [110, 220, 331, 443]) tone({ dur: 1.8, f0: f, f1: f * 0.99, vol: 0.12, attack: 0.005 }); noise({ dur: 0.4, type: 'lowpass', f0: 800, f1: 200, vol: 0.3 }); },
  win: () => { for (const [i, f] of [392, 523, 659, 784].entries()) tone({ dur: 0.5, type: 'triangle', f0: f, vol: 0.14, delay: i * 0.12 }); },
  denied: () => tone({ dur: 0.08, type: 'square', f0: 160, vol: 0.05 }),
};

export function play(name) {
  if (muted) return;
  const s = SOUNDS[name];
  if (s && ensure()) s();
}

// Map sim events to sounds.
export function soundForEvent(ev) {
  switch (ev.type) {
    case 'swing': play(ev.ability === 'secondary' ? 'heavySwing' : 'swing'); break;
    case 'damage': if (ev.kind !== 'ring') play(ev.amount >= 25 ? 'heavyHit' : 'hit'); break;
    case 'projectile': play(ev.kind === 'paralyze' ? 'paralyze' : 'firebolt'); break;
    case 'dash': play('charge'); break;
    case 'zoneStart': play(ev.kind === 'apocalypse' ? 'meteorCast' : 'lightningCast'); break;
    case 'zoneBlast': play(ev.kind === 'apocalypse' ? 'explosion' : 'lightning'); break;
    case 'blink': play('blink'); break;
    case 'nova': play('nova'); break;
    case 'parryStart': play('parryUp'); break;
    case 'parried': play('parry'); break;
    case 'leap': play('leap'); break;
    case 'land': play('land'); break;
    case 'berserk': play('berserk'); break;
    case 'orbTaken': play('orb'); break;
    case 'death': play('death'); break;
    case 'fight': play('gong'); break;
    case 'matchEnd': play('win'); break;
    default:
  }
}
