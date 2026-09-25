// Three.js scene: renderer, isometric camera, lights, bloom, and the arena itself.
// Sim coordinates (x, y) map to Three (x, 0, y). Height is Three's +y.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { constants as C } from '/services/sim/index.js';

export const VIEW_HEIGHT = 19; // world units visible vertically
// Camera direction: yawed 45 degrees (classic isometric), pitched ~40 degrees down.
const CAM_DIR = new THREE.Vector3(1, 1.2, 1).normalize();
const CAM_DIST = 60;
export const MSAA_SAMPLES = 4;

// Screen axes expressed in sim coordinates (used for WASD and gamepad movement).
export const SCREEN_RIGHT = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
export const SCREEN_UP = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };

function rand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Procedural flagstone floor with a rune circle in the middle. Returns {map, bump}.
function floorTextures() {
  const size = 2048;
  const span = 30; // meters covered by the texture
  const px = size / span;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const bumpCv = document.createElement('canvas');
  bumpCv.width = bumpCv.height = size;
  const b = bumpCv.getContext('2d');
  const r = rand(42);
  g.fillStyle = '#1a1714';
  g.fillRect(0, 0, size, size);
  b.fillStyle = '#000';
  b.fillRect(0, 0, size, size);

  const tile = 1.5 * px;
  for (let row = 0; row * tile < size; row++) {
    const offset = (row % 2) * tile * 0.5;
    for (let col = -1; col * tile < size; col++) {
      const x = col * tile + offset, y = row * tile;
      const shade = 58 + r() * 34;
      const warm = r() * 10;
      g.fillStyle = `rgb(${shade + warm},${shade + warm * 0.6},${shade - 4})`;
      const gap = 3;
      g.fillRect(x + gap, y + gap, tile - gap * 2, tile - gap * 2);
      // Speckle and wear.
      for (let k = 0; k < 40; k++) {
        const s = r() * 40 - 20;
        g.fillStyle = `rgba(${s > 0 ? 255 : 0},${s > 0 ? 240 : 0},${s > 0 ? 220 : 0},${Math.abs(s) / 400})`;
        g.fillRect(x + r() * tile, y + r() * tile, 2 + r() * 6, 2 + r() * 6);
      }
      b.fillStyle = `rgb(${150 + r() * 60},${150 + r() * 60},${150 + r() * 60})`;
      b.fillRect(x + gap, y + gap, tile - gap * 2, tile - gap * 2);
      if (r() < 0.25) { // cracks
        g.strokeStyle = 'rgba(10,8,6,0.7)';
        b.strokeStyle = '#000';
        g.lineWidth = b.lineWidth = 2;
        let cx = x + r() * tile, cy = y + r() * tile;
        g.beginPath(); b.beginPath();
        g.moveTo(cx, cy); b.moveTo(cx, cy);
        for (let s = 0; s < 4; s++) {
          cx += (r() - 0.5) * tile * 0.5; cy += (r() - 0.5) * tile * 0.5;
          g.lineTo(cx, cy); b.lineTo(cx, cy);
        }
        g.stroke(); b.stroke();
      }
      if (r() < 0.12) { // moss
        g.fillStyle = 'rgba(60,90,40,0.35)';
        g.beginPath();
        g.arc(x + r() * tile, y + r() * tile, 6 + r() * 16, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // Rune circle, center of the arena.
  const c = size / 2;
  g.save();
  g.translate(c, c);
  g.strokeStyle = 'rgba(200,170,110,0.55)';
  g.lineWidth = 6;
  for (const rr of [3.2, 3.9, 9.5, 10.1]) {
    g.beginPath(); g.arc(0, 0, rr * px, 0, Math.PI * 2); g.stroke();
  }
  g.font = `${0.55 * px}px serif`;
  g.fillStyle = 'rgba(210,180,120,0.6)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const runes = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.save();
    g.rotate(a);
    g.fillText(runes[i], 0, -3.55 * px);
    g.fillText(runes[(i * 7) % runes.length], 0, -9.8 * px);
    g.restore();
  }
  // Star.
  g.beginPath();
  for (let i = 0; i <= 5; i++) {
    const a = -Math.PI / 2 + i * ((Math.PI * 4) / 5);
    const x = Math.cos(a) * 3.2 * px, y = Math.sin(a) * 3.2 * px;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.restore();

  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(bumpCv);
  return { map, bump, span };
}

function stoneTexture(seed, w = 256, h = 256, base = [70, 64, 58]) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  const r = rand(seed);
  g.fillStyle = `rgb(${base.join(',')})`;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 1800; i++) {
    const s = (r() - 0.5) * 60;
    g.fillStyle = `rgba(${s > 0 ? 255 : 0},${s > 0 ? 250 : 0},${s > 0 ? 240 : 0},${Math.abs(s) / 500})`;
    g.fillRect(r() * w, r() * h, 1 + r() * 5, 1 + r() * 5);
  }
  // Block courses.
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = 2;
  const rows = 6;
  for (let i = 0; i <= rows; i++) {
    const y = (i / rows) * h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    for (let k = 0; k < 4; k++) {
      const x = ((k + (i % 2) * 0.5) / 4) * w;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + h / rows); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function lavaTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const g = cv.getContext('2d');
  const r = rand(7);
  g.fillStyle = '#300800';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 260; i++) {
    const x = r() * 512, y = r() * 512, rad = 10 + r() * 60;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const hot = r();
    grad.addColorStop(0, hot > 0.7 ? 'rgba(255,200,80,0.9)' : 'rgba(255,90,10,0.6)');
    grad.addColorStop(1, 'rgba(120,20,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

// Soft radial sprite used by glows.
export function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

const MOON_POS = new THREE.Vector3(-14, 30, 8);

// Image-based lighting, so metals have something to reflect. A tiny night scene baked into a
// PMREM env map. RoomEnvironment is a bright studio and would wash out the night arena.
//
// Everything bright sits on the horizon, on purpose. The env map also lights every rough
// surface diffusely, weighted by the cosine to the surface normal. The floor faces straight up,
// so horizon sources barely reach it, while armor, blades and staffs are mostly vertical and
// reflect them fully. A moon disc overhead measured +24% frame luminance (it double-counts the
// directional moon light); the horizon layout below measured about +5%.
function nightEnvironment(renderer) {
  const env = new THREE.Scene();
  const sky = new THREE.Color(0x151a2c), horizon = new THREE.Color(0x060508), lava = new THREE.Color(0x3a1004);
  const domeGeo = new THREE.SphereGeometry(10, 32, 16);
  const pos = domeGeo.attributes.position, colors = [], c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / 10; // -1 (below) .. 1 (zenith)
    if (t >= 0) c.copy(horizon).lerp(sky, Math.pow(t, 0.6));
    else c.copy(horizon).lerp(lava, Math.pow(-t, 0.8));
    colors.push(c.r, c.g, c.b);
  }
  domeGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  env.add(new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));

  // HDR panels (values above 1 survive: PMREM renders into half-float targets).
  const panel = (w, h, hex, scale, azimuth, y) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(scale), side: THREE.DoubleSide }));
    m.position.set(Math.cos(azimuth) * 9, y, Math.sin(azimuth) * 9);
    m.lookAt(0, y, 0);
    env.add(m);
  };
  for (let i = 0; i < 6; i++) panel(1.4, 0.9, 0xff9a4a, 8, (i / 6) * Math.PI * 2 + 0.3, 0.6); // torchlight
  panel(9, 0.7, 0x9fb4ff, 4.8, Math.atan2(MOON_POS.z, MOON_POS.x), 3); // cool moonlit rim, moon side

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  env.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return target.texture;
}

export function toWorld(x, y, h = 0) {
  return new THREE.Vector3(x, h, y);
}

export class World {
  constructor(canvas) {
    // No canvas MSAA: every frame goes through the composer, whose targets carry the MSAA below.
    // The canvas only ever receives the OutputPass full-screen quad.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    // Phones have 3x screens and small GPUs: cap lower on touch devices.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.matchMedia('(pointer: coarse)').matches ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07060b);
    this.scene.fog = new THREE.Fog(0x0d0810, 55, 110);
    this.scene.environment = nightEnvironment(this.renderer);

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 200);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.shake = 0;
    this.time = 0;

    // 4x MSAA on the composer's targets. Without it the scene renders aliased no matter what
    // the canvas asks for. Half float matches the composer default so bloom keeps its HDR range.
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: MSAA_SAMPLES });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.75, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.flickers = [];

    this.buildLights();
    this.buildArena();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x8d98c8, 0x3a1c14, 1.35));
    const moon = new THREE.DirectionalLight(0xc4d0ff, 2.8);
    moon.position.copy(MOON_POS);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    const s = moon.shadow.camera;
    s.left = -17; s.right = 17; s.top = 17; s.bottom = -17; s.near = 5; s.far = 70;
    moon.shadow.bias = -0.0005;
    moon.shadow.normalBias = 0.03;
    this.scene.add(moon);
    this.scene.add(moon.target);

    // Warm lava bounce from below the rim.
    const under = new THREE.PointLight(0xff5a1a, 220, 40, 2);
    under.position.set(0, -8, 0);
    this.scene.add(under);
  }

  addFlame(x, y, h, intensity = 18) {
    const light = new THREE.PointLight(0xff8a3a, intensity, 11, 2);
    light.position.set(x, h + 0.6, y);
    this.scene.add(light);
    this.flickers.push({ light, base: intensity, seed: Math.random() * 100, x, y, h });
    return light;
  }

  buildArena() {
    const R = C.ARENA_RADIUS;
    const { map, bump, span } = floorTextures();
    const floorMat = new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 0.6, roughness: 0.88, metalness: 0.05 });
    const floorGeo = new THREE.CircleGeometry(R + 1.2, 96);
    // UVs so the texture spans `span` meters, centered.
    const uv = floorGeo.attributes.uv, pos = floorGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / span + 0.5, pos.getY(i) / span + 0.5);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Platform sides.
    const sideTex = stoneTexture(3, 512, 128, [58, 52, 48]);
    sideTex.repeat.set(12, 1);
    const side = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 1.2, R - 1, 4, 96, 1, true),
      new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.95 }),
    );
    side.position.y = -2.01;
    this.scene.add(side);

    // Low rim wall with merlons, broken by 6 brazier posts.
    const wallTex = stoneTexture(5, 256, 256, [80, 74, 66]);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
    const segs = 48;
    for (let i = 0; i < segs; i++) {
      if (i % 8 === 0) continue;
      const a = (i / segs) * Math.PI * 2;
      const h = i % 2 ? 0.55 : 0.8;
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.7, h, ((R + 0.8) * Math.PI * 2) / segs - 0.08), wallMat);
      block.position.set(Math.cos(a) * (R + 0.8), h / 2, Math.sin(a) * (R + 0.8));
      block.rotation.y = -a;
      block.castShadow = true;
      block.receiveShadow = true;
      this.scene.add(block);
    }
    const postMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x2a2624, roughness: 0.5, metalness: 0.8 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const x = Math.cos(a) * (R + 0.8), y = Math.sin(a) * (R + 0.8);
      const post = new THREE.Mesh(new THREE.BoxGeometry(1, 2.2, 1), postMat);
      post.position.set(x, 1.1, y);
      post.castShadow = true;
      this.scene.add(post);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.3, 0.4, 12), ironMat);
      bowl.position.set(x, 2.4, y);
      this.scene.add(bowl);
      this.addFlame(x, y, 2.4, 16);
    }

    // Pillars.
    const pillarTex = stoneTexture(9, 256, 512, [96, 90, 82]);
    pillarTex.repeat.set(2, 1);
    const pillarMat = new THREE.MeshStandardMaterial({ map: pillarTex, roughness: 0.8 });
    for (const pl of C.PILLARS) {
      const group = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(pl.r * 1.25, pl.r * 1.35, 0.5, 20), pillarMat);
      base.position.y = 0.25;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(pl.r * 0.85, pl.r, 3.4, 20), pillarMat);
      shaft.position.y = 2.2;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(pl.r * 1.2, pl.r * 0.9, 0.5, 20), pillarMat);
      cap.position.y = 4.1;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.35, 0.35, 12), ironMat);
      bowl.position.y = 4.5;
      for (const m of [base, shaft, cap, bowl]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }
      group.position.set(pl.x, 0, pl.y);
      this.scene.add(group);
      this.addFlame(pl.x, pl.y, 4.5, 14);
    }

    // Lava sea far below.
    this.lavaTex = lavaTexture();
    const lava = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 260),
      new THREE.MeshBasicMaterial({ map: this.lavaTex, color: 0xffffff }),
    );
    lava.rotation.x = -Math.PI / 2;
    lava.position.y = -16;
    this.scene.add(lava);

    // Floating rock debris around the platform.
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x3a3230, roughness: 1, flatShading: true });
    const rr = rand(11);
    this.rocks = [];
    for (let i = 0; i < 26; i++) {
      const a = rr() * Math.PI * 2, d = R + 4 + rr() * 16;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.4 + rr() * 1.4, 0), rockMat);
      rock.position.set(Math.cos(a) * d, -2 - rr() * 9, Math.sin(a) * d);
      rock.rotation.set(rr() * 3, rr() * 3, rr() * 3);
      rock.castShadow = true;
      this.scene.add(rock);
      this.rocks.push({ mesh: rock, y: rock.position.y, s: rr() * 10 });
    }

    // Ring of fire wall, scaled to the current ring radius.
    const fireCv = document.createElement('canvas');
    fireCv.width = 256; fireCv.height = 128;
    const fg = fireCv.getContext('2d');
    const grad = fg.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0, 'rgba(255,220,120,1)');
    grad.addColorStop(0.3, 'rgba(255,110,20,0.8)');
    grad.addColorStop(1, 'rgba(160,20,0,0)');
    fg.fillStyle = grad;
    fg.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 40; i++) { // tongues
      fg.fillStyle = 'rgba(0,0,0,0.5)';
      fg.fillRect(i * 6.4, 0, 3, 40 + Math.random() * 60);
    }
    this.fireTex = new THREE.CanvasTexture(fireCv);
    this.fireTex.wrapS = THREE.RepeatWrapping;
    this.fireTex.repeat.set(10, 1);
    this.ring = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1.6, 96, 1, true),
      new THREE.MeshBasicMaterial({ map: this.fireTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.ring.position.y = 0.8;
    this.ring.visible = false;
    this.scene.add(this.ring);
    // Scorched ground outside the ring.
    this.ringFloor = new THREE.Mesh(
      new THREE.RingGeometry(1, R + 1.2, 96),
      new THREE.MeshBasicMaterial({ color: 0xff3300, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.ringFloor.rotation.x = -Math.PI / 2;
    this.ringFloor.position.y = 0.02;
    this.ringFloor.visible = false;
    this.scene.add(this.ringFloor);
  }

  setRing(radius) {
    const active = radius < C.ARENA_RADIUS - 0.01;
    this.ring.visible = this.ringFloor.visible = active;
    if (!active) return;
    this.ring.scale.set(radius, 1, radius);
    // Rebuild inner radius of the scorched floor by scaling a unit-inner ring is not exact; recreate cheaply.
    const R = C.ARENA_RADIUS + 1.2;
    if (Math.abs((this._ringR || 0) - radius) > 0.05) {
      this.ringFloor.geometry.dispose();
      this.ringFloor.geometry = new THREE.RingGeometry(radius, R, 96);
      this._ringR = radius;
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const aspect = w / h;
    // Always fit the arena: widen the view on portrait screens.
    const viewH = Math.max(VIEW_HEIGHT, (C.ARENA_RADIUS * 2 + 4) / aspect);
    this.viewH = viewH;
    this.camera.left = (-viewH * aspect) / 2;
    this.camera.right = (viewH * aspect) / 2;
    this.camera.top = viewH / 2;
    this.camera.bottom = -viewH / 2;
    this.camera.updateProjectionMatrix();
    this.pixelsPerUnit = h / viewH;
    this.width = w;
    this.height = h;
  }

  addShake(amount) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  // Screen pixel -> sim ground point.
  screenToGround(sx, sy) {
    const ndc = new THREE.Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return { x: 0, y: 0 };
    return { x: hit.x, y: hit.z };
  }

  // Sim point (+height) -> screen pixel.
  worldToScreen(x, y, h = 0) {
    const v = new THREE.Vector3(x, h, y).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height };
  }

  update(dt, focus) {
    this.time += dt;
    // Gentle drift toward the action; the whole arena always stays in view.
    const tx = focus ? focus.x * 0.18 : 0, ty = focus ? focus.y * 0.18 : 0;
    this.camTarget.x += (tx - this.camTarget.x) * Math.min(1, dt * 2);
    this.camTarget.z += (ty - this.camTarget.z) * Math.min(1, dt * 2);
    this.shake = Math.max(0, this.shake - dt * 2.8);
    const s = this.shake * this.shake * 0.6;
    const ox = (Math.random() - 0.5) * s, oy = (Math.random() - 0.5) * s;
    this.camera.position.copy(this.camTarget).addScaledVector(CAM_DIR, CAM_DIST);
    this.camera.position.x += ox;
    this.camera.position.y += oy;
    this.camera.lookAt(this.camTarget.x + ox, this.camTarget.y + oy, this.camTarget.z);

    for (const f of this.flickers) {
      const t = this.time * 9 + f.seed;
      f.light.intensity = f.base * (0.8 + Math.sin(t) * 0.08 + Math.sin(t * 2.7) * 0.07 + Math.random() * 0.08);
    }
    for (const r of this.rocks) {
      r.mesh.position.y = r.y + Math.sin(this.time * 0.6 + r.s) * 0.4;
      r.mesh.rotation.y += dt * 0.05;
    }
    this.lavaTex.offset.x = this.time * 0.004;
    this.lavaTex.offset.y = Math.sin(this.time * 0.1) * 0.02;
    this.fireTex.offset.x = -this.time * 0.25;
  }

  render() {
    this.composer.render();
  }
}
