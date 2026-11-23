// =====================================================================
// FishSchool — Boids 알고리즘 물고기 떼 (InstancedMesh)
//   · 분리(separation) · 정렬(alignment) · 응집(cohesion)
//   · 무리별 "집" 주변을 배회, 잠수함이 다가오면 흩어짐
//   · 같은 무리끼리만 이웃을 검사하므로 O(무리크기²) → 180마리도 가벼움
// =====================================================================
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from './config.js';

const NEIGHBOR_R2 = 7 * 7;
const SEP_R2 = 1.8 * 1.8;
const FLEE_R = 18;
const W_ALIGN = 1.2, W_COH = 0.9, W_SEP = 2.4, W_HOME = 0.35, W_FLEE = 26;
const MIN_SPEED = 2.5, MAX_SPEED = 7, FLEE_SPEED = 15;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, 1);

export class FishSchool {
  constructor(scene, fishGltfs, terrain) {
    this.terrain = terrain;
    this.time = 0;
    const S = CONFIG.fish.schools, P = CONFIG.fish.perSchool;
    this.count = S * P;
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.scale = new Float32Array(this.count);

    // ---- 모델 준비: glb가 있으면 그 지오메트리, 없으면 원뿔 ----
    const types = [];
    for (const g of fishGltfs) {
      let mesh = null;
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
      if (!mesh) continue;
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      const size = geo.boundingBox.getSize(new THREE.Vector3());
      const c = geo.boundingBox.getCenter(new THREE.Vector3());
      geo.translate(-c.x, -c.y, -c.z);
      geo.scale(1.3 / Math.max(size.x, size.y, size.z), 1.3 / Math.max(size.x, size.y, size.z), 1.3 / Math.max(size.x, size.y, size.z));
      types.push({ geo, mat: mesh.material, tint: false });
    }
    if (types.length === 0) types.push({ geo: this._fallbackGeometry(), mat: this._fallbackMaterial(), tint: true });

    // ---- 무리 정의 ----
    const palettes = [
      [0xffb347, 0xffcc66], [0x5fd3ff, 0x9be7ff], [0xff6b8a, 0xffa0b4], [0xc7f464, 0xe8ff9e], [0xb8a1ff, 0xd9ccff],
    ];
    this.schools = [];
    const typeCounts = new Array(types.length).fill(0);
    for (let s = 0; s < S; s++) {
      const a = (s / S) * Math.PI * 2 + 0.4;
      const r = 70 + (s % 3) * 50;
      const center = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      const type = s % types.length;
      this.schools.push({ start: s * P, end: (s + 1) * P, center, home: new THREE.Vector3(), phase: s * 1.7, type, palette: palettes[s % palettes.length], scatter: 0 });
      typeCounts[type] += P;
    }

    // ---- InstancedMesh 생성 (모델 종류별 1개) ----
    this.meshes = types.map((t, i) => {
      const mesh = new THREE.InstancedMesh(t.geo, t.mat, typeCounts[i]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // 인스턴스가 넓게 퍼져 있음
      scene.add(mesh);
      return { mesh, tint: t.tint, next: 0 };
    });
    this.slot = new Int32Array(this.count);   // 물고기 → 인스턴스 번호
    this.meshOf = new Int32Array(this.count); // 물고기 → 메시 번호

    const col = new THREE.Color();
    for (const sc of this.schools) {
      this._updateHome(sc, 0);
      for (let i = sc.start; i < sc.end; i++) {
        this.pos[i * 3] = sc.home.x + (Math.random() - 0.5) * 12;
        this.pos[i * 3 + 1] = sc.home.y + (Math.random() - 0.5) * 6;
        this.pos[i * 3 + 2] = sc.home.z + (Math.random() - 0.5) * 12;
        this.vel[i * 3] = Math.random() - 0.5;
        this.vel[i * 3 + 2] = Math.random() - 0.5;
        this.scale[i] = 0.7 + Math.random() * 0.6;
        const m = this.meshes[sc.type];
        this.meshOf[i] = sc.type;
        this.slot[i] = m.next++;
        if (m.tint) {
          col.setHex(sc.palette[0]).lerp(col.clone().setHex(sc.palette[1]), Math.random());
          m.mesh.setColorAt(this.slot[i], col);
        }
      }
    }
  }

  /** 대체 모델: 몸통 원뿔 + 납작한 꼬리 원뿔 (+Z가 머리) */
  _fallbackGeometry() {
    const body = new THREE.ConeGeometry(0.28, 1.2, 5);
    body.rotateX(Math.PI / 2); // 원뿔 꼭짓점이 +Z(앞)
    const tail = new THREE.ConeGeometry(0.28, 0.45, 3);
    tail.rotateX(Math.PI / 2);
    tail.scale(0.25, 1.3, 1);
    tail.translate(0, 0, -0.75);
    const geo = BufferGeometryUtils.mergeGeometries([body.toNonIndexed(), tail.toNonIndexed()]);
    geo.computeVertexNormals();
    return geo;
  }

  _fallbackMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.5, metalness: 0.2 });
    this.wiggleUniform = { value: 0 };
    // 꼬리 흔들기: 뒤쪽(z<0) 정점일수록 크게 좌우로
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.wiggleUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          float ph = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.4;
          float back = max(0.0, 0.2 - position.z);
          transformed.x += sin(uTime * 12.0 + ph) * back * 0.32;`);
    };
    return mat;
  }

  /** 무리의 "집"이 지형 위를 천천히 배회 */
  _updateHome(sc, t) {
    const h = sc.home;
    h.x = sc.center.x + Math.sin(t * 0.045 + sc.phase) * 45;
    h.z = sc.center.z + Math.cos(t * 0.037 + sc.phase * 1.3) * 45;
    const floor = this.terrain.heightAt(h.x, h.z);
    h.y = Math.min(-8, floor + 10 + Math.sin(t * 0.1 + sc.phase) * 4);
  }

  update(dt, subPos) {
    this.time += dt;
    if (this.wiggleUniform) this.wiggleUniform.value = this.time;
    const P = this.pos, V = this.vel;

    for (const sc of this.schools) {
      this._updateHome(sc, this.time);
      sc.scatter = Math.max(0, sc.scatter - dt * 0.4);
      const coh = W_COH * (1 - sc.scatter * 0.9); // 흩어진 직후엔 응집력 약화

      for (let i = sc.start; i < sc.end; i++) {
        const ix = i * 3;
        const px = P[ix], py = P[ix + 1], pz = P[ix + 2];
        let ax = 0, ay = 0, az = 0;
        let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0, sx = 0, sy = 0, sz = 0, n = 0;

        for (let j = sc.start; j < sc.end; j++) {
          if (j === i) continue;
          const jx = j * 3;
          const dx = P[jx] - px, dy = P[jx + 1] - py, dz = P[jx + 2] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > NEIGHBOR_R2) continue;
          n++;
          cx += dx; cy += dy; cz += dz;
          vx += V[jx]; vy += V[jx + 1]; vz += V[jx + 2];
          if (d2 < SEP_R2 && d2 > 1e-4) { sx -= dx / d2; sy -= dy / d2; sz -= dz / d2; }
        }
        if (n > 0) {
          ax += (vx / n - V[ix]) * W_ALIGN + (cx / n) * coh;
          ay += (vy / n - V[ix + 1]) * W_ALIGN + (cy / n) * coh;
          az += (vz / n - V[ix + 2]) * W_ALIGN + (cz / n) * coh;
        }
        ax += sx * W_SEP; ay += sy * W_SEP; az += sz * W_SEP;

        // 집으로 돌아가려는 힘 (멀수록 강하게)
        const hx = sc.home.x - px, hy = sc.home.y - py, hz = sc.home.z - pz;
        const hd = Math.sqrt(hx * hx + hy * hy + hz * hz) + 1e-3;
        const hw = W_HOME * Math.min(1, hd / 25);
        ax += (hx / hd) * hw * 4; ay += (hy / hd) * hw * 4; az += (hz / hd) * hw * 4;

        // 잠수함 회피
        let maxSpeed = MAX_SPEED;
        const fx = px - subPos.x, fy = py - subPos.y, fz = pz - subPos.z;
        const fd = Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (fd < FLEE_R) {
          const k = (1 - fd / FLEE_R) * W_FLEE / (fd + 1e-3);
          ax += fx * k; ay += fy * k; az += fz * k;
          maxSpeed = FLEE_SPEED;
          sc.scatter = 1;
        }

        // 지형 / 수면 회피
        const floor = this.terrain.heightAt(px, pz);
        if (py < floor + 3) ay += (floor + 3 - py) * 4;
        if (py > -4) ay -= (py + 4) * 4;

        // 속도 적분 + 최소/최대 속도 제한
        V[ix] += ax * dt; V[ix + 1] += ay * dt; V[ix + 2] += az * dt;
        V[ix + 1] *= 0.98; // 물고기는 수평으로 헤엄치는 경향
        let sp = Math.sqrt(V[ix] ** 2 + V[ix + 1] ** 2 + V[ix + 2] ** 2);
        if (sp < 1e-4) { V[ix] = 1; sp = 1; }
        const target = Math.min(maxSpeed, Math.max(MIN_SPEED, sp));
        const f = target / sp;
        V[ix] *= f; V[ix + 1] *= f; V[ix + 2] *= f;
        P[ix] += V[ix] * dt; P[ix + 1] += V[ix + 1] * dt; P[ix + 2] += V[ix + 2] * dt;

        // 인스턴스 행렬: 진행 방향을 바라보게
        _v.set(V[ix], V[ix + 1], V[ix + 2]).normalize();
        _q.setFromUnitVectors(FORWARD, _v);
        _s.setScalar(this.scale[i]);
        _m.compose(_p.set(P[ix], P[ix + 1], P[ix + 2]), _q, _s);
        this.meshes[this.meshOf[i]].mesh.setMatrixAt(this.slot[i], _m);
      }
    }
    for (const m of this.meshes) m.mesh.instanceMatrix.needsUpdate = true;
  }
}
