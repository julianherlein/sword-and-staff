// Visual effects: particles, projectile and telegraph views, transient effects, floating text.
// Everything here is driven by the sim's state (persistent things) and events (one-shots).
import * as THREE from 'three';
import { constants as C } from '/services/sim/index.js';
import { glowTexture } from './world.js';
import { TEAM_COLORS } from './models.js';

const MAX_PARTICLES = 6000;

class Particles {
  constructor(scene, additive) {
    this.count = 0;
    this.pos = new Float32Array(MAX_PARTICLES * 3);
    this.col = new Float32Array(MAX_PARTICLES * 3);
    this.alpha = new Float32Array(MAX_PARTICLES);
    this.size = new Float32Array(MAX_PARTICLES);
    this.data = []; // per-particle simulation data, parallel to buffers
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: { ppu: { value: 40 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color;
        uniform float ppu; varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = color; vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * ppu;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          float f = pow(1.0 - d, 1.6);
          gl_FragColor = vec4(vColor, vAlpha * f);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(o) {
    if (this.count >= MAX_PARTICLES) return;
    const i = this.count++;
    this.data[i] = {
      x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
      life: 0, max: o.life || 0.6, s0: o.size || 0.3, s1: o.size1 ?? 0, a0: o.alpha ?? 1,
      g: o.gravity || 0, drag: o.drag ?? 1.5, r: o.r, gg: o.g2, b: o.b,
    };
  }

  update(dt) {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const d = this.data[i];
      d.life += dt;
      if (d.life >= d.max) continue;
      const k = Math.exp(-d.drag * dt);
      d.vx *= k; d.vy *= k; d.vz *= k;
      d.vy -= d.g * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      const t = d.life / d.max;
      this.data[n] = d;
      this.pos[n * 3] = d.x; this.pos[n * 3 + 1] = d.y; this.pos[n * 3 + 2] = d.z;
      this.col[n * 3] = d.r; this.col[n * 3 + 1] = d.gg; this.col[n * 3 + 2] = d.b;
      this.alpha[n] = d.a0 * (1 - t) * Math.min(1, d.life * 30);
      this.size[n] = d.s0 + (d.s1 - d.s0) * t;
      n++;
    }
    this.count = n;
    this.geo.setDrawRange(0, n);
    for (const k of ['position', 'color', 'alpha', 'size']) this.geo.attributes[k].needsUpdate = true;
  }
}

const col = (hex) => { const c = new THREE.Color(hex); return { r: c.r, g2: c.g, b: c.b }; };

const KIND_COLOR = {
  firebolt: 0xff7a2a, paralyze: 0xc77dff, lightning: 0x9fe8ff, apocalypse: 0xff4a1a,
};

export class Vfx {
  constructor(world, floaterLayer) {
    this.world = world;
    this.scene = world.scene;
    this.floaters = floaterLayer;
    this.glowTex = glowTexture();
    this.add = new Particles(this.scene, true);
    this.alpha = new Particles(this.scene, false);
    this.projViews = new Map();
    this.zoneViews = new Map();
    this.effects = [];
    this.hitStop = 0;
    this.slowMo = 0;

    // Fixed pool of dynamic lights: changing the light count would recompile every shader.
    this.lights = [];
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 9, 2);
      l.position.set(0, -50, 0);
      this.scene.add(l);
      this.lights.push({ light: l, t: 0, dur: 0, peak: 0, follow: null });
    }

    // Health orb.
    this.orb = new THREE.Group();
    const orbCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.38, 1),
      new THREE.MeshStandardMaterial({ color: 0x9dffb0, emissive: 0x2dff6a, emissiveIntensity: 2.2, roughness: 0.2, flatShading: true }),
    );
    const orbGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0x4dff88, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    orbGlow.scale.setScalar(2.2);
    this.orb.add(orbCore, orbGlow);
    this.orbCore = orbCore;
    this.orb.position.set(C.ORB.x, 1, C.ORB.y);
    this.orb.visible = false;
    this.scene.add(this.orb);
    this.orbLight = new THREE.PointLight(0x4dff88, 0, 7, 2);
    this.orbLight.position.set(C.ORB.x, 1.2, C.ORB.y);
    this.scene.add(this.orbLight);
  }

  flash(x, y, h, color, peak, dur, follow = null) {
    // Reuse the dimmest light that is not attached to a live projectile or meteor.
    const free = this.lights.filter((l) => l.follow === null);
    const slot = (free.length ? free : this.lights).reduce((a, b) => (a.light.intensity <= b.light.intensity ? a : b));
    slot.light.color.setHex(color);
    slot.light.position.set(x, h, y);
    slot.t = 0; slot.dur = dur; slot.peak = peak; slot.follow = follow;
    slot.light.intensity = peak;
    return slot;
  }

  burst(x, y, h, color, n, opts = {}) {
    const c = col(color);
    const sp = opts.speed ?? 5;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = opts.up ?? 0.6;
      const v = sp * (0.3 + Math.random() * 0.7);
      (opts.normal ? this.alpha : this.add).spawn({
        x: x + (Math.random() - 0.5) * (opts.spread || 0), y: h, z: y + (Math.random() - 0.5) * (opts.spread || 0),
        vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: (Math.random() * 2 - 0.4) * v * up,
        life: (opts.life || 0.5) * (0.6 + Math.random() * 0.6), size: opts.size || 0.25, size1: opts.size1 ?? 0,
        gravity: opts.gravity ?? 6, drag: opts.drag ?? 2.5, alpha: opts.alpha ?? 1, ...c,
      });
    }
  }

  ringWave(x, y, color, radius, dur = 0.4, width = 0.25, h = 0.05) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(1 - width, 1, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, h, y);
    this.scene.add(m);
    this.effects.push({
      t: 0, update: (e, dt) => {
        e.t += dt;
        const k = e.t / dur;
        const s = 0.2 + (1 - (1 - k) ** 3) * radius;
        m.scale.set(s, s, s);
        m.material.opacity = 1 - k;
        if (k >= 1) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); return false; }
        return true;
      },
    });
  }

  scorch(x, y, radius, dur = 5) {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 32),
      new THREE.MeshBasicMaterial({ map: this.glowTex, color: 0x000000, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.015 + Math.random() * 0.005, y);
    this.scene.add(m);
    this.effects.push({
      t: 0, update: (e, dt) => {
        e.t += dt;
        m.material.opacity = 0.75 * (1 - e.t / dur);
        if (e.t >= dur) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); return false; }
        return true;
      },
    });
  }

  arc(p, range, arcDeg, color, dur = 0.16) {
    const theta = (arcDeg * Math.PI) / 180;
    const m = new THREE.Mesh(
      new THREE.RingGeometry(range * 0.35, range, 32, 1, -theta / 2, theta),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    const holder = new THREE.Group();
    holder.add(m);
    holder.position.set(p.x, 0.9, p.y);
    holder.rotation.y = -p.facing;
    this.scene.add(holder);
    this.effects.push({
      t: 0, update: (e, dt) => {
        e.t += dt;
        const k = e.t / dur;
        m.material.opacity = 0.9 * (1 - k);
        m.scale.setScalar(0.85 + k * 0.2);
        if (k >= 1) { this.scene.remove(holder); m.geometry.dispose(); m.material.dispose(); return false; }
        return true;
      },
    });
  }

  lightningBolt(x, y) {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0xdff8ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const build = (sx, sy, sz, ex, ey, ez, width, depth) => {
      let px = sx, py = sy, pz = sz;
      const steps = 9;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        const jitter = i === steps ? 0 : 0.6;
        const nx = sx + (ex - sx) * k + (Math.random() - 0.5) * jitter;
        const ny = sy + (ey - sy) * k;
        const nz = sz + (ez - sz) * k + (Math.random() - 0.5) * jitter;
        const len = Math.hypot(nx - px, ny - py, nz - pz);
        const seg = new THREE.Mesh(new THREE.BoxGeometry(width, len, width), material);
        seg.position.set((px + nx) / 2, (py + ny) / 2, (pz + nz) / 2);
        seg.lookAt(nx, ny, nz);
        seg.rotateX(Math.PI / 2);
        group.add(seg);
        if (depth < 1 && Math.random() < 0.3) build(nx, ny, nz, nx + (Math.random() - 0.5) * 3, ny - 2.5, nz + (Math.random() - 0.5) * 3, width * 0.5, depth + 1);
        px = nx; py = ny; pz = nz;
      }
    };
    build(x + 1.5, 16, y - 1.5, x, 0, y, 0.12, 0);
    this.scene.add(group);
    this.effects.push({
      t: 0, update: (e, dt) => {
        e.t += dt;
        material.opacity = e.t < 0.08 ? 1 : Math.max(0, 1 - (e.t - 0.08) / 0.2) * (Math.random() > 0.3 ? 1 : 0.3);
        if (e.t >= 0.3) { this.scene.remove(group); group.traverse((o) => o.geometry && o.geometry.dispose()); material.dispose(); return false; }
        return true;
      },
    });
  }

  text(x, y, h, str, cls = '', color = null) {
    const s = this.world.worldToScreen(x, y, h);
    const el = document.createElement('div');
    el.className = `floater ${cls}`;
    el.textContent = str;
    el.style.left = `${s.x + (Math.random() - 0.5) * 24}px`;
    el.style.top = `${s.y}px`;
    if (color) el.style.color = color;
    this.floaters.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  // One-shot events from the sim. `players` is the current player list; `me` the local slot (or -1).
  onEvent(ev, players, me) {
    const P = (id) => players[id];
    switch (ev.type) {
      case 'swing': {
        const p = P(ev.id);
        const heavy = ev.ability === 'secondary';
        this.arc(p, ev.range, ev.arc, heavy ? 0xffa040 : 0xdfe8ff, heavy ? 0.22 : 0.14);
        if (ev.combo === 3) this.arc(p, ev.range * 1.1, ev.arc + 20, 0x9fd0ff, 0.2);
        break;
      }
      case 'dash': this.burst(ev.x, ev.y, 0.2, 0xb8a58a, 18, { normal: true, speed: 3, up: 0.3, size: 0.5, size1: 1, life: 0.6, gravity: 0, alpha: 0.5 }); break;
      case 'chargeHit':
        this.burst(ev.x, ev.y, 1, 0xffe0a0, 30, { speed: 9, size: 0.2 });
        this.world.addShake(0.45);
        this.hitStop = Math.max(this.hitStop, 0.07);
        break;
      case 'parryStart': this.ringWave(P(ev.id).x, P(ev.id).y, 0xffd36a, 1.4, 0.25, 0.15, 1); break;
      case 'parried': {
        this.burst(ev.x, ev.y, 1.1, 0xffd36a, 24, { speed: 7, size: 0.18 });
        this.flash(ev.x, ev.y, 1.5, 0xffd36a, 30, 0.2);
        this.text(ev.x, ev.y, 2.4, 'BLOCKED', 'status', '#ffd36a');
        break;
      }
      case 'counter':
        this.text(P(ev.id).x, P(ev.id).y, 2.9, 'COUNTER!', 'big', '#ffd36a');
        this.world.addShake(0.4);
        this.hitStop = Math.max(this.hitStop, 0.09);
        break;
      case 'reflect': this.burst(ev.x, ev.y, 1, 0xffd36a, 20, { speed: 6, size: 0.2 }); break;
      case 'leap': this.burst(ev.x, ev.y, 0.2, 0xb8a58a, 20, { normal: true, speed: 4, up: 0.2, size: 0.6, size1: 1.2, life: 0.7, gravity: 0, alpha: 0.5 }); break;
      case 'land':
        this.ringWave(ev.x, ev.y, 0xffc070, ev.r, 0.35, 0.3);
        this.burst(ev.x, ev.y, 0.2, 0xa89478, 40, { normal: true, speed: 7, up: 0.15, size: 0.6, size1: 1.4, life: 0.8, gravity: 0, alpha: 0.6 });
        this.scorch(ev.x, ev.y, 1.6, 3);
        this.world.addShake(0.55);
        break;
      case 'berserk': {
        const p = P(ev.id);
        this.burst(p.x, p.y, 1, 0xff2a10, 50, { speed: 6, up: 1.2, size: 0.3, life: 0.8, gravity: -2 });
        this.ringWave(p.x, p.y, 0xff3010, 2.5, 0.4);
        this.text(p.x, p.y, 2.9, 'BERSERK!', 'big', '#ff5a3a');
        this.flash(p.x, p.y, 1.5, 0xff3010, 40, 0.5);
        break;
      }
      case 'projectile': this.flash(ev.x, ev.y, 1.2, KIND_COLOR[ev.kind], 20, 0.12); break;
      case 'projHit': {
        const c = KIND_COLOR[ev.kind];
        this.burst(ev.x, ev.y, 1, c, ev.kind === 'paralyze' ? 30 : 22, { speed: 6, size: 0.22, life: 0.45 });
        this.flash(ev.x, ev.y, 1.3, c, 35, 0.2);
        if (ev.target >= 0) this.world.addShake(0.12);
        break;
      }
      case 'projFade': this.burst(ev.x, ev.y, 1, KIND_COLOR[ev.kind], 8, { speed: 2, size: 0.15 }); break;
      case 'zoneBlast':
        if (ev.kind === 'lightning') {
          this.lightningBolt(ev.x, ev.y);
          this.burst(ev.x, ev.y, 0.3, 0xbff4ff, 45, { speed: 8, size: 0.16, life: 0.4 });
          this.ringWave(ev.x, ev.y, 0x9fe8ff, ev.r, 0.25, 0.2);
          this.flash(ev.x, ev.y, 3, 0xbff4ff, 160, 0.25);
          this.scorch(ev.x, ev.y, ev.r * 0.8, 4);
          this.world.addShake(0.3);
        } else {
          this.burst(ev.x, ev.y, 0.5, 0xff6a1a, 140, { speed: 11, up: 0.9, size: 0.55, size1: 0.1, life: 0.9, gravity: 4 });
          this.burst(ev.x, ev.y, 0.5, 0xffe08a, 60, { speed: 6, up: 1.2, size: 0.35, life: 0.5 });
          this.burst(ev.x, ev.y, 0.5, 0x302420, 50, { normal: true, speed: 4, up: 0.8, size: 1, size1: 2.2, life: 1.6, gravity: -1, alpha: 0.55 });
          this.ringWave(ev.x, ev.y, 0xff8a3a, ev.r * 1.5, 0.5, 0.3);
          this.flash(ev.x, ev.y, 3, 0xff6a1a, 400, 0.6);
          this.scorch(ev.x, ev.y, ev.r * 1.1, 7);
          this.world.addShake(1.0);
          this.hitStop = Math.max(this.hitStop, 0.06);
        }
        break;
      case 'nova':
        this.ringWave(ev.x, ev.y, 0x9fdcff, ev.r, 0.35, 0.35, 0.3);
        this.ringWave(ev.x, ev.y, 0xffffff, ev.r * 0.8, 0.25, 0.1, 0.6);
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2;
          this.add.spawn({ x: ev.x, y: 0.5, z: ev.y, vx: Math.cos(a) * 11, vz: Math.sin(a) * 11, vy: Math.random() * 2, life: 0.35, size: 0.25, drag: 4, ...col(0xcff0ff) });
        }
        this.flash(ev.x, ev.y, 1.5, 0x9fdcff, 60, 0.35);
        break;
      case 'blink': {
        this.burst(ev.x, ev.y, 1, 0xc77dff, 35, { speed: 4, up: 1, size: 0.25, gravity: -3 });
        this.burst(ev.tx, ev.ty, 1, 0xe0b0ff, 35, { speed: 5, up: 1, size: 0.25, gravity: -3 });
        const n = 14;
        for (let i = 0; i < n; i++) {
          const k = i / n;
          this.add.spawn({ x: ev.x + (ev.tx - ev.x) * k, y: 1, z: ev.y + (ev.ty - ev.y) * k, life: 0.35, size: 0.4, ...col(0xc77dff) });
        }
        this.flash(ev.tx, ev.ty, 1.5, 0xc77dff, 40, 0.25);
        break;
      }
      case 'damage': {
        const big = ev.amount >= 25;
        this.text(ev.x, ev.y, 2.2, `${ev.amount}`, big ? 'dmg big' : 'dmg', ev.id === me ? '#ff5a4a' : '#fff4d6');
        this.burst(ev.x, ev.y, 1, 0xaa1010, Math.min(30, 6 + ev.amount), { normal: true, speed: 4, size: 0.12, life: 0.5, gravity: 12, alpha: 0.9 });
        if (ev.kind === 'melee') this.burst(ev.x, ev.y, 1.1, 0xffffff, 8, { speed: 7, size: 0.12, life: 0.2 });
        if (big && ev.kind === 'melee') { this.hitStop = Math.max(this.hitStop, 0.06); this.world.addShake(0.35); }
        if (ev.id === me) this.world.addShake(0.15);
        break;
      }
      case 'status':
        if (ev.status === 'stun') this.text(P(ev.id).x, P(ev.id).y, 2.7, 'STUNNED', 'status', '#ffe066');
        if (ev.status === 'root') this.text(P(ev.id).x, P(ev.id).y, 2.7, 'ROOTED', 'status', '#d6a4ff');
        break;
      case 'interrupt': this.text(P(ev.id).x, P(ev.id).y, 3.1, 'INTERRUPTED', 'status', '#ffffff'); break;
      case 'death':
        this.burst(ev.x, ev.y, 1, TEAM_COLORS[ev.id], 80, { speed: 8, up: 1.2, size: 0.3, life: 1 });
        this.flash(ev.x, ev.y, 2, 0xffffff, 120, 0.5);
        this.world.addShake(0.8);
        this.slowMo = 1.0;
        break;
      case 'orbSpawn':
        this.ringWave(ev.x, ev.y, 0x4dff88, 2, 0.5);
        this.text(ev.x, ev.y, 2.2, 'HEALTH ORB', 'status', '#6dffa0');
        break;
      case 'orbTaken':
        this.burst(ev.x, ev.y, 1, 0x4dff88, 50, { speed: 5, up: 1.2, size: 0.3, gravity: -4 });
        this.text(P(ev.id).x, P(ev.id).y, 2.5, `+${C.ORB.heal}`, 'dmg heal', '#6dffa0');
        break;
      default:
    }
  }

  syncProjectiles(list, alpha, prev) {
    const seen = new Set();
    for (const pr of list) {
      seen.add(pr.id);
      let v = this.projViews.get(pr.id);
      const color = KIND_COLOR[pr.kind];
      if (!v) {
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(pr.r * 0.9, 12, 10),
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.setScalar(pr.r * 7);
        core.add(glow);
        this.scene.add(core);
        const light = this.flash(pr.x, pr.y, 1.2, color, 25, 99, pr.id);
        v = { core, glow, light, kind: pr.kind };
        this.projViews.set(pr.id, v);
      }
      const pp = prev && prev.get(pr.id);
      const x = pp ? pp.x + (pr.x - pp.x) * alpha : pr.x;
      const y = pp ? pp.y + (pr.y - pp.y) * alpha : pr.y;
      v.core.position.set(x, 1.1, y);
      v.light.light.position.set(x, 1.3, y);
      v.light.light.color.setHex(color);
      v.glow.material.color.setHex(color);
      // Trail.
      const c = col(color);
      for (let i = 0; i < 2; i++) {
        this.add.spawn({ x: x + (Math.random() - 0.5) * 0.15, y: 1.1 + (Math.random() - 0.5) * 0.15, z: y + (Math.random() - 0.5) * 0.15, vy: 0.5, life: 0.3, size: pr.r * 1.6, size1: 0, drag: 3, ...c });
      }
      if (pr.kind === 'paralyze') v.core.rotation.y += 0.3;
    }
    for (const [id, v] of this.projViews) {
      if (seen.has(id)) continue;
      this.scene.remove(v.core);
      v.core.geometry.dispose();
      v.light.follow = null;
      v.light.t = 0; v.light.dur = 0.08;
      this.projViews.delete(id);
    }
  }

  syncZones(list, me) {
    const seen = new Set();
    for (const z of list) {
      seen.add(z.id);
      let v = this.zoneViews.get(z.id);
      const color = KIND_COLOR[z.kind];
      if (!v) {
        const group = new THREE.Group();
        group.position.set(z.x, 0.04, z.y);
        const edge = new THREE.Mesh(new THREE.RingGeometry(z.r * 0.94, z.r, 64),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
        const fill = new THREE.Mesh(new THREE.CircleGeometry(z.r, 64),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
        const base = new THREE.Mesh(new THREE.CircleGeometry(z.r, 64),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }));
        for (const m of [edge, fill, base]) { m.rotation.x = -Math.PI / 2; group.add(m); }
        fill.position.y = 0.005;
        edge.position.y = 0.01;
        this.scene.add(group);
        v = { group, edge, fill, meteor: null };
        if (z.kind === 'apocalypse') {
          const meteor = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1),
            new THREE.MeshStandardMaterial({ color: 0x2a1a10, emissive: 0xff4a1a, emissiveIntensity: 1.6, flatShading: true }));
          const mg = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xff5a1a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
          mg.scale.setScalar(4);
          meteor.add(mg);
          this.scene.add(meteor);
          v.meteor = meteor;
          v.light = this.flash(z.x, z.y, 10, 0xff5a1a, 60, 99, -z.id);
        }
        this.zoneViews.set(z.id, v);
      }
      const k = Math.min(1, z.t / z.delay);
      v.fill.scale.setScalar(Math.max(0.01, k));
      v.fill.material.opacity = 0.2 + k * 0.25;
      v.edge.material.opacity = 0.6 + Math.sin(z.t * 30) * 0.3 * k;
      if (v.meteor) {
        // Falls from above the zone, offset toward the camera so it stays on screen the whole way.
        const h = 11 * (1 - k);
        const mx = z.x + 4 * (1 - k), my = z.y + 4 * (1 - k);
        v.meteor.position.set(mx, h + 0.5, my);
        v.meteor.rotation.x += 0.2; v.meteor.rotation.z += 0.13;
        v.light.light.position.set(mx, h + 1, my);
        const c = col(0xff6a1a);
        for (let i = 0; i < 4; i++) this.add.spawn({ x: mx + (Math.random() - 0.5) * 0.8, y: h + 0.5, z: my + (Math.random() - 0.5) * 0.8, vy: 2, life: 0.5, size: 0.9, size1: 0.1, drag: 2, ...c });
      }
      void me;
    }
    for (const [id, v] of this.zoneViews) {
      if (seen.has(id)) continue;
      this.scene.remove(v.group);
      v.group.traverse((o) => o.geometry && o.geometry.dispose());
      if (v.meteor) { this.scene.remove(v.meteor); v.light.follow = null; v.light.t = 0; v.light.dur = 0.05; }
      this.zoneViews.delete(id);
    }
  }

  // Continuous per-frame effects from player state (trails, status particles).
  playerAmbient(p, dt) {
    if (!p.alive) return;
    if (p.dash) {
      this.add.spawn({ x: p.x, y: 0.9, z: p.y, life: 0.25, size: 0.8, size1: 0.2, ...col(0xffd8a0), alpha: 0.5 });
    }
    if (p.slowT > 0 && Math.random() < dt * 20) {
      this.add.spawn({ x: p.x + (Math.random() - 0.5), y: 0.2 + Math.random() * 1.6, z: p.y + (Math.random() - 0.5), vy: -0.5, life: 0.6, size: 0.12, ...col(0xbfe8ff) });
    }
    if (p.berserk > 0 && Math.random() < dt * 40) {
      this.add.spawn({ x: p.x + (Math.random() - 0.5) * 0.8, y: 0.3 + Math.random() * 1.5, z: p.y + (Math.random() - 0.5) * 0.8, vy: 2, life: 0.5, size: 0.2, ...col(0xff3010) });
    }
    if (p.leap && Math.random() < dt * 60) {
      this.add.spawn({ x: p.x, y: 1 + (p.z || 0), z: p.y, life: 0.3, size: 0.5, size1: 0.1, ...col(0xffc070), alpha: 0.6 });
    }
  }

  ambient(dt, time) {
    // Embers rising from the lava.
    if (Math.random() < dt * 30) {
      const a = Math.random() * Math.PI * 2, d = C.ARENA_RADIUS + 1.5 + Math.random() * 10;
      this.add.spawn({ x: Math.cos(a) * d, y: -4, z: Math.sin(a) * d, vy: 3 + Math.random() * 3, vx: (Math.random() - 0.5), life: 3, size: 0.12, drag: 0.1, ...col(0xff7a2a) });
    }
    // Brazier flames.
    for (const f of this.world.flickers) {
      if (Math.random() < dt * 22) {
        this.add.spawn({ x: f.x + (Math.random() - 0.5) * 0.4, y: f.h + 0.2, z: f.y + (Math.random() - 0.5) * 0.4, vy: 2.5, life: 0.5, size: 0.5, size1: 0.05, drag: 1, ...col(Math.random() < 0.5 ? 0xff7a2a : 0xffc04a) });
      }
    }
    void time;
  }

  update(dt, time, orb, ringRadius) {
    this.add.material.uniforms.ppu.value = this.world.pixelsPerUnit * this.world.renderer.getPixelRatio();
    this.alpha.material.uniforms.ppu.value = this.add.material.uniforms.ppu.value;
    this.add.update(dt);
    this.alpha.update(dt);
    this.effects = this.effects.filter((e) => e.update(e, dt));
    for (const s of this.lights) {
      if (s.follow !== null) continue;
      s.t += dt;
      s.light.intensity = s.dur > 0 ? Math.max(0, s.peak * (1 - s.t / s.dur)) : 0;
    }
    this.orb.visible = !!orb && orb.active;
    this.orbLight.intensity = this.orb.visible ? 12 : 0;
    if (this.orb.visible) {
      this.orb.position.y = 1 + Math.sin(time * 2.5) * 0.15;
      this.orbCore.rotation.y += dt * 1.5;
      this.orbCore.rotation.x += dt * 0.7;
    }
    this.world.setRing(ringRadius);
    if (ringRadius < C.ARENA_RADIUS && Math.random() < dt * 60) {
      const a = Math.random() * Math.PI * 2;
      this.add.spawn({ x: Math.cos(a) * ringRadius, y: 0.2, z: Math.sin(a) * ringRadius, vy: 3 + Math.random() * 2, life: 0.6, size: 0.6, size1: 0.1, ...col(Math.random() < 0.5 ? 0xff5a1a : 0xffb04a) });
    }
  }

  // Compile every effect's shaders up front. Otherwise the first lightning or meteor of a match
  // stalls a frame (100-200ms) while WebGL links a new program mid-fight.
  warmup() {
    const Y = -40; // far below the arena: compiled, never seen
    const fake = [{ x: 0, y: Y, facing: 0 }, { x: 0, y: Y, facing: 0 }];
    const evs = [
      { type: 'swing', id: 0, ability: 'primary', combo: 3, range: 2, arc: 100 },
      { type: 'swing', id: 0, ability: 'secondary', range: 2, arc: 160 },
      { type: 'zoneBlast', kind: 'lightning', x: 0, y: Y, r: 1 },
      { type: 'zoneBlast', kind: 'apocalypse', x: 0, y: Y, r: 1 },
      { type: 'nova', x: 0, y: Y, r: 1 }, { type: 'land', x: 0, y: Y, r: 1 },
    ];
    for (const ev of evs) this.onEvent(ev, fake, -1);
    this.syncProjectiles([{ id: -1, kind: 'firebolt', x: 0, y: Y, r: 0.3 }], 1, null);
    this.syncZones([{ id: -2, kind: 'apocalypse', x: 0, y: Y, r: 1, t: 0, delay: 1 }], -1);
    this.world.renderer.compile(this.scene, this.world.camera);
    this.clearTransient();
    this.hitStop = 0;
    this.slowMo = 0;
    this.world.shake = 0;
  }

  clearTransient() {
    this.syncProjectiles([], 1, null);
    this.syncZones([], -1);
  }
}
