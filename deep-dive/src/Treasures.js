// =====================================================================
// TreasureField — 해저에 흩어진 보물 상자 10개
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { fitModel } from './utils.js';

export class TreasureField {
  constructor(scene, gltf, ocean, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.gltf = gltf;
    this.glowTexture = ocean.glowTexture;
    this.items = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    if (!gltf) {
      this.mats = {
        wood: new THREE.MeshStandardMaterial({ color: 0x7a4a24, flatShading: true, roughness: 0.8 }),
        gold: new THREE.MeshStandardMaterial({ color: 0xffc83a, emissive: 0x8a5a00, emissiveIntensity: 0.6, metalness: 0.8, roughness: 0.3, flatShading: true }),
        coins: new THREE.MeshBasicMaterial({ color: 0xffe066 }),
      };
    }
  }

  /** 대체 모델: 상자 + 반원통 뚜껑 + 금색 띠 */
  _makeChest() {
    if (this.gltf) return fitModel(this.gltf.scene.clone(true), 2.4);
    const { wood, gold, coins } = this.mats;
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 1.2), wood);
    box.position.y = 0.5;
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 1.0, -0.6);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.8, 7, 1, false, 0, Math.PI), wood);
    lid.rotation.z = Math.PI / 2;
    lid.position.z = 0.6;
    lidPivot.add(lid);
    lidPivot.rotation.x = -0.5; // 살짝 열린 뚜껑
    const coinPile = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.15, 1.0), coins);
    coinPile.position.y = 1.0;
    for (const x of [-0.7, 0.7]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.05, 1.25), gold);
      band.position.set(x, 0.5, 0);
      g.add(band);
    }
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 0.1), gold);
    lock.position.set(0, 0.8, 0.62);
    g.add(box, lidPivot, coinPile, lock);
    g.scale.setScalar(1.4);
    return g;
  }

  /** 새 게임마다 무작위 재배치 */
  spawn(count = CONFIG.treasureCount) {
    for (const it of this.items) this.group.remove(it.object);
    this.items = [];
    const t = this.terrain;
    const spots = [];
    const ok = (x, z) => Math.hypot(x, z) > 55 && spots.every((s) => Math.hypot(s.x - x, s.z - z) > 42);
    // 고정 명소: 난파선 옆 1개, 해구 바닥 2개
    const w = t.wreckPosition;
    spots.push(new THREE.Vector3(w.x + 10, 0, w.z - 6));
    for (const z of [-90, 60]) {
      // 해구 중심선 근처에서 가장 깊은 곳 찾기
      let best = null, bestH = 0;
      for (let x = 100; x <= 200; x += 4) {
        const h = t.heightAt(x, z);
        if (h < bestH) { bestH = h; best = new THREE.Vector3(x, 0, z); }
      }
      if (best) spots.push(best);
    }
    let guard = 0;
    while (spots.length < count && guard++ < 2000) {
      const a = Math.random() * Math.PI * 2, r = 60 + Math.random() * 180;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) > 225 || Math.abs(z) > 225 || !ok(x, z)) continue;
      spots.push(new THREE.Vector3(x, 0, z));
    }
    for (const p of spots.slice(0, count)) {
      p.y = t.heightAt(p.x, p.z) + 0.1;
      const obj = this._makeChest();
      obj.position.copy(p);
      obj.rotation.y = Math.random() * Math.PI * 2;
      // 은은한 금빛 후광 (멀리서도 살짝 보이게)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTexture, color: 0xffcf4a, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.setScalar(7);
      glow.position.y = 1.6;
      obj.add(glow);
      this.group.add(obj);
      this.items.push({ object: obj, glow, position: p.clone().setY(p.y + 1), collected: false, anim: 0, phase: Math.random() * 6 });
    }
  }

  get remaining() { return this.items.filter((i) => !i.collected); }
  get collectedCount() { return this.items.filter((i) => i.collected).length; }

  /** 근처의 보물 수집. 이번 프레임에 수집한 보물 배열 반환 */
  update(dt, subPos, time) {
    const got = [];
    for (const it of this.items) {
      if (it.collected) {
        // 수집 애니메이션: 떠오르며 작아짐
        if (it.anim < 1) {
          it.anim = Math.min(1, it.anim + dt * 1.2);
          it.object.position.y += dt * 4;
          it.object.scale.setScalar(Math.max(0.001, 1 - it.anim));
          if (it.anim >= 1) it.object.visible = false;
        }
        continue;
      }
      it.glow.material.opacity = 0.4 + 0.2 * Math.sin(time * 2.5 + it.phase);
      if (it.position.distanceTo(subPos) < CONFIG.collectRadius + 1.5) {
        it.collected = true;
        got.push(it);
      }
    }
    return got;
  }
}
