// Low-poly characters built from primitives, animated procedurally from sim state + events.
// Models face local +X; group.rotation.y = -facing turns them toward the sim angle.
import * as THREE from 'three';

export const TEAM_COLORS = [0x3b8cff, 0xff4a3d];
export const TEAM_CSS = ['#3b8cff', '#ff4a3d'];

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...opts });
}

function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Pivot group so limbs rotate around joints.
function joint(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  return g;
}

function buildWarrior(team) {
  const tc = TEAM_COLORS[team];
  const steel = mat(0xdfe3ea, { roughness: 0.35, metalness: 0.75 });
  const darkSteel = mat(0x8a909a, { roughness: 0.45, metalness: 0.7 });
  const leather = mat(0x4a3322, { roughness: 0.9 });
  const cloth = mat(tc, { roughness: 0.8, emissive: tc, emissiveIntensity: 0.18 });
  const gold = mat(0xd4a64a, { roughness: 0.3, metalness: 0.9 });

  const root = new THREE.Group();
  const body = joint(0, 0, 0);
  root.add(body);

  const legL = joint(0, 0.85, 0.16), legR = joint(0, 0.85, -0.16);
  for (const leg of [legL, legR]) {
    leg.add(mesh(new THREE.BoxGeometry(0.22, 0.5, 0.2), leather, 0, -0.25, 0));
    leg.add(mesh(new THREE.BoxGeometry(0.24, 0.38, 0.22), darkSteel, 0, -0.62, 0));
    leg.add(mesh(new THREE.BoxGeometry(0.32, 0.12, 0.22), darkSteel, 0.05, -0.8, 0));
    body.add(leg);
  }

  const torso = joint(0, 0.85, 0);
  body.add(torso);
  torso.add(mesh(new THREE.BoxGeometry(0.42, 0.62, 0.56), steel, 0, 0.35, 0));
  torso.add(mesh(new THREE.BoxGeometry(0.44, 0.5, 0.36), cloth, 0.03, 0.18, 0)); // tabard
  torso.add(mesh(new THREE.BoxGeometry(0.46, 0.08, 0.58), leather, 0, 0.02, 0)); // belt
  torso.add(mesh(new THREE.BoxGeometry(0.06, 0.06, 0.1), gold, 0.24, 0.02, 0)); // buckle
  torso.add(mesh(new THREE.SphereGeometry(0.17, 12, 8), steel, 0, 0.62, 0.33)); // pauldrons
  torso.add(mesh(new THREE.SphereGeometry(0.17, 12, 8), steel, 0, 0.62, -0.33));

  const head = joint(0, 0.78, 0);
  torso.add(head);
  head.add(mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.34, 14), steel, 0, 0.12, 0));
  head.add(mesh(new THREE.SphereGeometry(0.19, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), steel, 0, 0.29, 0));
  head.add(mesh(new THREE.BoxGeometry(0.03, 0.04, 0.26), mat(0x050505), 0.2, 0.15, 0)); // visor slit
  head.add(mesh(new THREE.BoxGeometry(0.03, 0.2, 0.03), gold, 0.2, 0.12, 0)); // nose guard
  const plume = mesh(new THREE.BoxGeometry(0.4, 0.14, 0.06), cloth, -0.08, 0.46, 0);
  plume.rotation.z = 0.35;
  head.add(plume);

  // Cape.
  const cape = joint(-0.2, 0.62, 0);
  torso.add(cape);
  const capeMesh = mesh(new THREE.BoxGeometry(0.04, 0.95, 0.5), cloth, 0, -0.45, 0);
  cape.add(capeMesh);

  // Sword arm (right = -Z side when facing +X).
  const armR = joint(0, 0.6, -0.36);
  torso.add(armR);
  armR.add(mesh(new THREE.BoxGeometry(0.14, 0.44, 0.14), darkSteel, 0, -0.22, 0));
  const handR = joint(0, -0.46, 0);
  armR.add(handR);
  handR.add(mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), leather));
  const sword = joint(0, 0, 0);
  handR.add(sword);
  sword.rotation.z = -Math.PI / 2; // blade points forward (+X)
  sword.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8), leather, 0, -0.06, 0));
  sword.add(mesh(new THREE.BoxGeometry(0.32, 0.05, 0.06), gold, 0, 0.06, 0));
  sword.add(mesh(new THREE.SphereGeometry(0.045, 8, 6), gold, 0, -0.19, 0));
  const bladeMat = mat(0xe8ecf2, { roughness: 0.15, metalness: 1, emissive: 0x000000 });
  const blade = mesh(new THREE.BoxGeometry(0.1, 1.05, 0.025), bladeMat, 0, 0.6, 0);
  sword.add(blade);

  // Shield arm (left = +Z).
  const armL = joint(0, 0.6, 0.36);
  torso.add(armL);
  armL.add(mesh(new THREE.BoxGeometry(0.14, 0.44, 0.14), darkSteel, 0, -0.22, 0));
  const shield = joint(0.14, -0.32, 0.1);
  armL.add(shield);
  const shieldFace = mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.06, 20), cloth);
  shieldFace.rotation.z = Math.PI / 2;
  shield.add(shieldFace);
  const rim = mesh(new THREE.TorusGeometry(0.36, 0.03, 6, 24), steel);
  rim.rotation.y = Math.PI / 2;
  shield.add(rim);
  const boss = mesh(new THREE.SphereGeometry(0.09, 10, 8), gold, 0.04, 0, 0);
  shield.add(boss);

  return { root, body, torso, head, legL, legR, armR, armL, handR, sword, shield, cape, blade, bladeMat, weaponTip: blade };
}

function buildMage(team) {
  const tc = TEAM_COLORS[team];
  const robe = mat(new THREE.Color(tc).multiplyScalar(0.55).getHex(), { roughness: 0.85 });
  const robeTrim = mat(0xd9c38a, { roughness: 0.5, metalness: 0.6 });
  const hatMat = mat(new THREE.Color(tc).multiplyScalar(0.8).getHex(), { roughness: 0.8, emissive: tc, emissiveIntensity: 0.15 });
  const skin = mat(0xe0b48f, { roughness: 0.7 });
  const beard = mat(0xe8e6e0, { roughness: 1 });
  const wood = mat(0x5a3a1e, { roughness: 0.8 });

  const root = new THREE.Group();
  const body = joint(0, 0, 0);
  root.add(body);

  const legL = joint(0, 0.5, 0.12), legR = joint(0, 0.5, -0.12); // hidden under the robe, drive the hem sway
  body.add(legL, legR);
  const skirt = mesh(new THREE.ConeGeometry(0.48, 1.05, 16, 1, true), robe, 0, 0.52, 0);
  skirt.material.side = THREE.DoubleSide;
  body.add(skirt);
  const hem = mesh(new THREE.TorusGeometry(0.46, 0.035, 6, 24), robeTrim, 0, 0.04, 0);
  hem.rotation.x = Math.PI / 2;
  body.add(hem);

  const torso = joint(0, 0.95, 0);
  body.add(torso);
  torso.add(mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.55, 14), robe, 0, 0.2, 0));
  const belt = mesh(new THREE.TorusGeometry(0.25, 0.04, 6, 18), robeTrim, 0, 0, 0);
  belt.rotation.x = Math.PI / 2;
  torso.add(belt);
  torso.add(mesh(new THREE.SphereGeometry(0.13, 10, 8), robe, 0, 0.45, 0.22)); // shoulders
  torso.add(mesh(new THREE.SphereGeometry(0.13, 10, 8), robe, 0, 0.45, -0.22));

  const head = joint(0, 0.62, 0);
  torso.add(head);
  head.add(mesh(new THREE.SphereGeometry(0.17, 14, 10), skin, 0, 0.08, 0));
  const beardMesh = mesh(new THREE.ConeGeometry(0.13, 0.36, 10), beard, 0.1, -0.12, 0);
  beardMesh.rotation.z = Math.PI + 0.3;
  head.add(beardMesh);
  head.add(mesh(new THREE.BoxGeometry(0.03, 0.03, 0.2), mat(0x111111), 0.15, 0.12, 0)); // eyes
  const brim = mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.03, 20), hatMat, 0, 0.22, 0);
  head.add(brim);
  const hatLow = mesh(new THREE.ConeGeometry(0.22, 0.42, 14), hatMat, -0.02, 0.43, 0);
  head.add(hatLow);
  const hatTip = mesh(new THREE.ConeGeometry(0.1, 0.34, 10), hatMat, -0.12, 0.72, 0);
  hatTip.rotation.z = 0.5;
  head.add(hatTip);
  head.add(mesh(new THREE.TorusGeometry(0.21, 0.025, 6, 18), robeTrim, 0, 0.25, 0)).rotation.x = Math.PI / 2;

  // Staff arm (right = -Z).
  const armR = joint(0, 0.45, -0.3);
  torso.add(armR);
  armR.add(mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.42, 8), robe, 0, -0.2, 0));
  const handR = joint(0, -0.42, 0);
  armR.add(handR);
  handR.add(mesh(new THREE.SphereGeometry(0.06, 8, 6), skin));
  const staff = joint(0.06, 0, 0);
  handR.add(staff);
  staff.add(mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.8, 8), wood, 0, 0.25, 0));
  const claw = mesh(new THREE.TorusGeometry(0.1, 0.025, 6, 12, Math.PI * 1.4), robeTrim, 0, 1.18, 0);
  staff.add(claw);
  const orbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff7a2a, emissiveIntensity: 2.5, roughness: 0.2 });
  const orb = mesh(new THREE.SphereGeometry(0.1, 14, 10), orbMat, 0, 1.2, 0);
  orb.castShadow = false;
  staff.add(orb);

  // Casting hand (left = +Z).
  const armL = joint(0, 0.45, 0.3);
  torso.add(armL);
  armL.add(mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.42, 8), robe, 0, -0.2, 0));
  const handL = joint(0, -0.42, 0);
  armL.add(handL);
  handL.add(mesh(new THREE.SphereGeometry(0.06, 8, 6), skin));

  return { root, body, torso, head, legL, legR, armR, armL, handR, handL, staff, orb, orbMat, skirt, weaponTip: orb };
}

const ELEMENT_COLOR = {
  primary: 0xff7a2a, secondary: 0x9fe8ff, dash: 0xc77dff, q: 0xc77dff, e: 0x9fdcff, r: 0xff3b1a,
};

// Runtime view of one player: owns the model and all its animation state.
export class CharacterView {
  constructor(scene, team, cls, glowTex) {
    this.team = team;
    this.cls = cls;
    this.parts = cls === 'warrior' ? buildWarrior(team) : buildMage(team);
    this.root = this.parts.root;
    this.parts.body.scale.setScalar(1.2); // readable at arena zoom; the ground ring keeps the true hit radius
    scene.add(this.root);
    this.walkPhase = 0;
    this.swing = null; // {t, dur, kind, dir}
    this.deathT = 0;
    this.materials = [];
    this.root.traverse((o) => { if (o.isMesh && !this.materials.includes(o.material)) this.materials.push(o.material); });
    this.baseEmissive = this.materials.map((m) => m.emissive.clone());
    this.baseEmissiveI = this.materials.map((m) => m.emissiveIntensity);

    // Selection ring on the ground in team color.
    const ringMat = new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team], transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 40), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.root.add(this.ring);
    // Aim chevron in front of the ring.
    const chev = new THREE.Shape();
    chev.moveTo(0.95, 0); chev.lineTo(0.75, 0.14); chev.lineTo(0.8, 0); chev.lineTo(0.75, -0.14); chev.closePath();
    this.chevron = new THREE.Mesh(new THREE.ShapeGeometry(chev), ringMat);
    this.chevron.rotation.x = -Math.PI / 2;
    this.chevron.position.y = 0.035;
    this.root.add(this.chevron);

    // Parry bubble.
    this.bubble = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.bubble.scale.setScalar(1.15);
    this.bubble.position.y = 1.1;
    this.root.add(this.bubble);

    // Hand/orb glow sprite for casting.
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.glow.scale.setScalar(0.9);
    (this.parts.orb || this.parts.blade).add(this.glow);
    if (this.parts.blade) this.glow.position.y = 0.4;

    // Stun stars.
    this.stars = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), new THREE.MeshBasicMaterial({ color: 0xffe066 }));
      s.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.35, 0, Math.sin((i / 3) * Math.PI * 2) * 0.35);
      this.stars.add(s);
    }
    this.stars.position.y = 2.65;
    this.stars.visible = false;
    this.root.add(this.stars);

    // Root shackles.
    this.shackle = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.06, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xc77dff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }),
    );
    this.shackle.rotation.x = Math.PI / 2;
    this.shackle.visible = false;
    this.root.add(this.shackle);
  }

  onEvent(ev) {
    if (ev.type === 'swing') {
      const dur = ev.ability === 'secondary' ? 0.3 : 0.2;
      this.swing = { t: 0, dur, kind: ev.ability, dir: ev.combo === 2 ? -1 : 1 };
    } else if (ev.type === 'cast' && this.cls === 'mage') {
      this.castFlash = { t: 0, color: ELEMENT_COLOR[ev.ability] };
    } else if (ev.type === 'death') {
      this.deathT = 0.0001;
    }
  }

  reset() {
    this.deathT = 0;
    this.swing = null;
    this.root.rotation.set(0, this.root.rotation.y, 0);
    this.root.position.y = 0;
  }

  update(dt, p, time) {
    const P = this.parts;
    this.root.position.x = p.x;
    this.root.position.z = p.y;
    this.root.rotation.y = -p.facing;

    // Death: topple and sink.
    if (!p.alive) {
      if (!this.deathT) this.deathT = 0.0001;
      this.deathT += dt;
      const k = Math.min(1, this.deathT / 0.5);
      this.parts.body.rotation.z = (-Math.PI / 2) * k * k;
      this.parts.body.position.y = 0.15 * k;
      this.ring.visible = this.chevron.visible = false;
      this.stars.visible = this.shackle.visible = false;
      this.bubble.material.opacity = 0;
      return;
    }
    this.deathT = 0;
    P.body.rotation.set(0, 0, 0);
    this.ring.visible = this.chevron.visible = true;

    const speed = Math.hypot(p.vx, p.vy);
    const moving = speed > 0.3 && !p.dash && !p.leap;
    this.walkPhase += dt * (moving ? speed * 2.1 : 0);
    const swingLeg = moving ? Math.sin(this.walkPhase) * 0.7 : 0;
    P.legL.rotation.z = swingLeg;
    P.legR.rotation.z = -swingLeg;
    const bob = moving ? Math.abs(Math.sin(this.walkPhase)) * 0.06 : Math.sin(time * 2.2) * 0.015;
    P.body.position.y = bob + (p.z || 0);

    // Move direction relative to facing, so strafing leans correctly.
    const lean = p.dash ? 0.5 : moving ? 0.12 : 0;
    P.torso.rotation.z = -lean;

    // Arm defaults.
    P.armL.rotation.set(0, 0, moving ? -swingLeg * 0.6 : 0);
    P.armR.rotation.set(0, 0, moving ? swingLeg * 0.6 : 0);

    if (this.cls === 'warrior') this.animateWarrior(dt, p, time);
    else this.animateMage(dt, p, time);

    if (p.leap) {
      const k = p.leap.t / p.leap.dur;
      P.body.rotation.z = -Math.sin(k * Math.PI) * 0.5;
      P.armR.rotation.z = 2.6;
    }

    // Hit flash.
    const flash = p.hitFlash > 0 ? 1 : 0;
    const berserk = p.berserk > 0;
    for (let i = 0; i < this.materials.length; i++) {
      const m = this.materials[i];
      if (m === P.orbMat) continue;
      if (flash) m.emissive.setRGB(1, 1, 1);
      else if (berserk) m.emissive.setRGB(0.35 + Math.sin(time * 12) * 0.1, 0.02, 0);
      else m.emissive.copy(this.baseEmissive[i]);
      m.emissiveIntensity = flash ? 0.9 : berserk ? 1 : this.baseEmissiveI[i];
    }

    // Parry bubble.
    const bo = p.parry > 0 ? 0.28 + Math.sin(time * 30) * 0.06 : 0;
    this.bubble.material.opacity += (bo - this.bubble.material.opacity) * Math.min(1, dt * 25);

    // Status visuals.
    this.stars.visible = p.stun > 0;
    if (this.stars.visible) this.stars.rotation.y = time * 6;
    this.shackle.visible = p.root > 0;
    if (this.shackle.visible) {
      this.shackle.position.y = 0.25 + Math.sin(time * 8) * 0.05;
      this.shackle.scale.setScalar(1 + Math.sin(time * 10) * 0.06);
    }
    this.ring.material.opacity = 0.55 + Math.sin(time * 4) * 0.15;
  }

  animateWarrior(dt, p, time) {
    const P = this.parts;
    P.cape.rotation.z = 0.15 + Math.min(0.9, Math.hypot(p.vx, p.vy) * 0.08) + Math.sin(time * 5) * 0.04;
    // Guard pose: sword forward-down, shield in front.
    P.armR.rotation.z += 0.35; // sword held forward, tip slightly up
    P.armR.rotation.x = 0.2;
    P.armL.rotation.z += -0.9;
    P.armL.rotation.x = 0.35;
    P.sword.rotation.x = 0;

    const cast = p.cast;
    if (cast && cast.key === 'secondary') {
      const k = Math.min(1, cast.t / cast.total);
      P.armR.rotation.z = -0.5 + k * 3.2; // raise overhead
      P.armR.rotation.x = 0.2 + k * 0.4;
    } else if (cast && cast.key === 'primary') {
      P.armR.rotation.z = 1.35; // wind up to the sword side
      P.armR.rotation.y = 1.3;
    }

    if (this.swing) {
      const s = this.swing;
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      const e = 1 - (1 - k) * (1 - k);
      if (s.kind === 'secondary') {
        P.armR.rotation.z = 2.7 - e * 4.2;
        P.torso.rotation.y = -0.6 + e * 1.2;
      } else {
        // Horizontal sweep: arm forward (z), then swing around the vertical axis (y).
        P.armR.rotation.z = 1.35;
        P.armR.rotation.y = s.dir > 0 ? 1.3 - e * 2.6 : -1.3 + e * 2.6;
        P.armR.rotation.x = 0;
        P.torso.rotation.y = (s.dir > 0 ? -0.5 + e : 0.5 - e) * 0.8;
      }
      if (k >= 1) { this.swing = null; P.torso.rotation.y = 0; }
    } else {
      P.torso.rotation.y *= 0.8;
    }

    if (p.parry > 0) {
      P.armL.rotation.z = -1.5;
      P.armL.rotation.x = 0;
      P.shield.position.set(0.3, -0.3, -0.25);
    } else {
      P.shield.position.set(0.14, -0.32, 0.1);
    }
    if (p.dash) {
      P.armL.rotation.z = -1.4;
      P.armR.rotation.z = -1;
    }
    const glowTarget = p.berserk > 0 ? 0.8 : 0;
    this.glow.material.opacity += (glowTarget - this.glow.material.opacity) * Math.min(1, dt * 8);
    this.glow.material.color.setHex(0xff3322);
    P.bladeMat.emissive.setHex(p.berserk > 0 ? 0x661100 : 0x000000);
  }

  animateMage(dt, p, time) {
    const P = this.parts;
    P.skirt.rotation.z = -Math.min(0.2, Math.hypot(p.vx, p.vy) * 0.02);
    P.armR.rotation.z += 0.25;
    P.armR.rotation.x = 0.15;
    P.armL.rotation.z += -0.1;
    P.staff.rotation.z = -0.25;

    let glow = 0.35 + Math.sin(time * 3) * 0.08;
    let color = 0xff7a2a;
    const cast = p.cast;
    if (cast) {
      const k = Math.min(1, cast.t / cast.total);
      color = ELEMENT_COLOR[cast.key];
      P.armR.rotation.z = 0.25 + k * 1.6;
      P.armL.rotation.z = 0.8 + k * 0.8;
      P.armL.rotation.x = -0.4;
      glow = 0.6 + k * 1.4;
    }
    if (this.castFlash) {
      this.castFlash.t += dt;
      const k = this.castFlash.t / 0.25;
      if (k >= 1) this.castFlash = null;
      else {
        color = this.castFlash.color;
        glow = Math.max(glow, 1.8 * (1 - k));
        P.armR.rotation.z = Math.max(P.armR.rotation.z, 1.4 * (1 - k));
        P.armL.rotation.z = Math.max(P.armL.rotation.z, 1.2 * (1 - k));
      }
    }
    P.orbMat.emissive.setHex(color);
    P.orbMat.emissiveIntensity = 1.5 + glow * 2;
    this.glow.material.color.setHex(color);
    this.glow.material.opacity = Math.min(1, glow * 0.6);
    this.glow.scale.setScalar(0.6 + glow * 0.5);
  }

  dispose(scene) {
    scene.remove(this.root);
    this.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
}
