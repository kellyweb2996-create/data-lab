// =====================================================================
// Shark — 순찰(patrol) → 추격(chase) → 후퇴(retreat) 상태 머신
// =====================================================================
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { fitModel, damp } from './utils.js';

const PATROL_SPEED = 6, CHASE_SPEED = 11.5;
const DETECT_R = 36, LOSE_R = 75, BITE_R = 4.8;
const _to = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class Shark {
  constructor(scene, gltf, terrain, center, index) {
    this.terrain = terrain;
    this.center = center.clone();
    this.index = index;
    this.group = new THREE.Group();
    this.mixer = null;
    this.tail = null;
    if (gltf) {
      const obj = skeletonClone(gltf.scene);
      this.group.add(fitModel(obj, 8));
      if (gltf.animations.length) {
        this.mixer = new THREE.AnimationMixer(obj);
        this.mixer.clipAction(gltf.animations[0]).play();
      }
    } else {
      this._buildFallback();
    }
    scene.add(this.group);
    this.position = this.group.position;
    this.velocity = new THREE.Vector3();
    this.reset();
  }

  /** 대체 모델: 길쭉한 몸통 + 지느러미 + 흔들리는 꼬리 (+Z가 머리) */
  _buildFallback() {
    const skin = new THREE.MeshStandardMaterial({ color: 0x5f7383, flatShading: true, roughness: 0.6 });
    const belly = new THREE.MeshStandardMaterial({ color: 0xc9d3d8, flatShading: true, roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), skin);
    body.scale.set(0.95, 0.9, 3.6);
    const under = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), belly);
    under.scale.set(0.8, 0.55, 3.2);
    under.position.set(0, -0.35, 0.2);
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.6, 7), skin);
    snout.rotation.x = Math.PI / 2;
    snout.position.z = 3.7;
    snout.scale.set(1, 0.7, 1);
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.7, 4), skin);
    dorsal.scale.set(0.25, 1, 1);
    dorsal.position.set(0, 1.4, 0.2);
    dorsal.rotation.x = -0.35;
    this.group.add(body, under, snout, dorsal);
    for (const side of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.8), skin);
      fin.position.set(side * 1.3, -0.4, 0.9);
      fin.rotation.set(0, side * -0.4, side * -0.35);
      this.group.add(fin);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 5, 4), new THREE.MeshBasicMaterial({ color: 0x050505 }));
      eye.position.set(side * 0.55, 0.15, 3.3);
      this.group.add(eye);
    }
    // 꼬리: 피벗을 축으로 좌우로 흔듦
    this.tail = new THREE.Group();
    this.tail.position.z = -3.3;
    const stalk = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.6, 6), skin);
    stalk.rotation.x = -Math.PI / 2;
    stalk.position.z = -0.6;
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.0, 0.7), skin);
    upper.position.set(0, 0.8, -1.4);
    upper.rotation.x = 0.6;
    const lower = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.3, 0.6), skin);
    lower.position.set(0, -0.5, -1.3);
    lower.rotation.x = -0.6;
    this.tail.add(stalk, upper, lower);
    this.group.add(this.tail);
  }

  reset() {
    // 순찰 경로: 중심 주변 원 위의 6개 지점
    this.waypoints = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const r = 45 + Math.random() * 25;
      const x = this.center.x + Math.cos(a) * r, z = this.center.z + Math.sin(a) * r;
      const y = Math.min(-12, this.terrain.heightAt(x, z) + 10 + Math.random() * 10);
      this.waypoints.push(new THREE.Vector3(x, y, z));
    }
    this.wp = 0;
    this.position.copy(this.waypoints[0]);
    this.velocity.set(0, 0, 1);
    this.state = 'patrol';
    this.stateTime = 0;
    this.swim = Math.random() * 10;
  }

  /**
   * @param sub        잠수함
   * @param subSafe    잠수함이 기지 근처라 공격 불가
   * @returns 'bite' 이면 이번 프레임에 물었음
   */
  update(dt, sub, subSafe) {
    this.stateTime += dt;
    if (this.mixer) this.mixer.update(dt * (this.state === 'chase' ? 2 : 1));
    const dist = this.position.distanceTo(sub.position);
    let speed = PATROL_SPEED;
    let event = null;

    switch (this.state) {
      case 'patrol': {
        const target = this.waypoints[this.wp];
        _desired.subVectors(target, this.position);
        if (_desired.length() < 8) this.wp = (this.wp + 1) % this.waypoints.length;
        if (dist < DETECT_R && !subSafe && this.stateTime > 2) this._setState('chase');
        break;
      }
      case 'chase': {
        speed = CHASE_SPEED;
        // 약간 앞을 예측해서 추격
        _desired.copy(sub.position).addScaledVector(sub.velocity, 0.5).sub(this.position);
        if (dist > LOSE_R || subSafe || this.stateTime > 16) this._setState('patrol');
        if (dist < BITE_R) { event = 'bite'; this._setState('retreat'); }
        break;
      }
      case 'retreat': {
        speed = 9;
        _desired.subVectors(this.position, sub.position);
        _desired.y = 2;
        if (this.stateTime > 5) this._setState('patrol');
        break;
      }
    }

    // 조향: 원하는 속도 쪽으로 서서히 회전 (상어는 급회전 불가)
    _desired.normalize().multiplyScalar(speed);
    // 지형/수면 회피
    const floor = this.terrain.heightAt(this.position.x, this.position.z);
    if (this.position.y < floor + 4) _desired.y += (floor + 4 - this.position.y) * 2;
    if (this.position.y > -5) _desired.y -= 4;
    this.velocity.lerp(_desired, damp(this.state === 'chase' ? 1.6 : 0.9, dt));
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = Math.max(this.position.y, floor + 2);

    // 몸 방향: 진행 방향을 부드럽게 바라봄
    const v = this.velocity.length();
    if (v > 0.1) {
      _to.copy(this.position).add(this.velocity);
      _look.lookAt(_to, this.position, UP); // +Z가 진행 방향이 되도록
      _q.setFromRotationMatrix(_look);
      this.group.quaternion.slerp(_q, damp(4, dt));
    }

    // 꼬리 흔들기 (속도에 비례)
    this.swim += dt * (2 + v * 0.7);
    if (this.tail) this.tail.rotation.y = Math.sin(this.swim * 2.2) * 0.45;
    return event;
  }

  _setState(s) { this.state = s; this.stateTime = 0; }
}
