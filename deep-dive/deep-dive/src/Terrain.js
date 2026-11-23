// =====================================================================
// Terrain — 심플렉스 노이즈 해저 지형 + 바위/산호/해초/난파선 배치
//   · heightAt(x,z): 충돌 판정용 높이 (메시와 같은 격자를 쌍선형 보간)
//   · obstacles: 바위·난파선 충돌 구 목록 [{pos, r}]
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { SimplexNoise, mulberry32, smoothstep, clamp, fitModel } from './utils.js';

export class Terrain {
  constructor(scene, ocean, assets) {
    this.scene = scene;
    this.ocean = ocean;
    this.rand = mulberry32(CONFIG.seed);
    this.noise = new SimplexNoise(this.rand);
    this.size = CONFIG.world.size;
    this.half = this.size / 2;
    this.seg = CONFIG.terrain.segments;
    this.step = this.size / this.seg;
    this.obstacles = [];
    this.time = 0;

    this._buildGround(assets.sand);
    this._scatterRocks();
    this._scatterCoral();
    this._scatterSeaweed();
    this._placeWreck(assets.shipwreck);
  }

  /** 노이즈로 만든 원본 높이 함수 */
  rawHeight(x, z) {
    const n = this.noise;
    const r = Math.hypot(x, z);
    // 기지 근처는 얕고 바깥으로 갈수록 깊어지는 분지
    let h = -38 - 48 * smoothstep(30, 200, r);
    // 큰 언덕 + 능선 (기지 바로 아래는 기복을 줄여 잠수 공간 확보)
    const relief = 0.25 + 0.75 * smoothstep(25, 85, r);
    h += n.fbm(x * 0.006, z * 0.006, 4) * 16 * relief;
    const ridge = 1 - Math.abs(n.noise2D(x * 0.018 + 40, z * 0.018 - 13));
    h += ridge * ridge * 7 * relief;
    h += n.noise2D(x * 0.07, z * 0.07) * 1.2; // 잔물결
    // 동쪽의 구불구불한 해구 (가장 깊은 곳 ~ -115m)
    const tx = 140 + 35 * Math.sin(z * 0.012) + 15 * n.noise2D(z * 0.01, 3.3);
    const td = Math.abs(x - tx);
    h -= 30 * Math.exp(-((td / 24) ** 2)) * smoothstep(-260, -150, z) * (1 - smoothstep(150, 260, z));
    // 세계 가장자리는 절벽으로 막음
    const edge = smoothstep(235, 305, Math.max(Math.abs(x), Math.abs(z)));
    h += edge * 95;
    return clamp(h, -118, -3);
  }

  _buildGround(sand) {
    const S = this.seg;
    const geo = new THREE.PlaneGeometry(this.size, this.size, S, S);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    this.heights = new Float32Array((S + 1) * (S + 1));
    for (let i = 0; i < pos.count; i++) {
      const h = this.rawHeight(pos.getX(i), pos.getZ(i));
      pos.setY(i, h);
      this.heights[i] = h;
    }
    // 정점 색: 얕은 모래 → 깊은 진흙, 경사면은 바위색, 군데군데 이끼
    const colors = new Float32Array(pos.count * 3);
    const sandC = new THREE.Color(0xd9c793), deepC = new THREE.Color(0x5d6266);
    const rockC = new THREE.Color(0x6f6a62), mossC = new THREE.Color(0x6d8a52);
    const c = new THREE.Color();
    for (let iz = 0; iz <= S; iz++) {
      for (let ix = 0; ix <= S; ix++) {
        const i = iz * (S + 1) + ix;
        const h = this.heights[i];
        const hx = this.heights[iz * (S + 1) + Math.min(S, ix + 1)] - this.heights[iz * (S + 1) + Math.max(0, ix - 1)];
        const hz = this.heights[Math.min(S, iz + 1) * (S + 1) + ix] - this.heights[Math.max(0, iz - 1) * (S + 1) + ix];
        const slope = Math.hypot(hx, hz) / (2 * this.step);
        c.copy(sandC).lerp(deepC, smoothstep(-35, -105, h));
        const moss = this.noise.noise2D(pos.getX(i) * 0.02, pos.getZ(i) * 0.02);
        if (moss > 0.35 && h > -80) c.lerp(mossC, (moss - 0.35) * 1.5);
        c.lerp(rockC, smoothstep(0.5, 1.1, slope));
        const j = 0.92 + this.rand() * 0.12; // 로우폴리 느낌을 주는 미세한 얼룩
        colors[i * 3] = c.r * j; colors[i * 3 + 1] = c.g * j; colors[i * 3 + 2] = c.b * j;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
    // 모래 텍스처가 있으면 적용 (없으면 정점 색만으로 로우폴리 스타일)
    if (sand.diffuse || sand.normal || sand.roughness) {
      for (const t of [sand.diffuse, sand.normal, sand.roughness]) {
        if (!t) continue;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(70, 70);
        t.anisotropy = 4;
      }
      if (sand.diffuse) { sand.diffuse.colorSpace = THREE.SRGBColorSpace; mat.map = sand.diffuse; }
      if (sand.normal) { mat.normalMap = sand.normal; mat.flatShading = false; }
      if (sand.roughness) mat.roughnessMap = sand.roughness;
    }
    this.ocean.applyCaustics(mat);
    this.ground = new THREE.Mesh(geo, mat);
    this.scene.add(this.ground);
  }

  /** 격자 높이를 쌍선형 보간 (메시와 거의 일치) */
  heightAt(x, z) {
    const S = this.seg;
    const fx = clamp((x + this.half) / this.step, 0, S - 1e-4);
    const fz = clamp((z + this.half) / this.step, 0, S - 1e-4);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const H = this.heights, w = S + 1;
    const h00 = H[iz * w + ix], h10 = H[iz * w + ix + 1];
    const h01 = H[(iz + 1) * w + ix], h11 = H[(iz + 1) * w + ix + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 1.0;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-dx / (2 * e), 1, -dz / (2 * e)).normalize();
  }

  /** 배치용 무작위 위치 (기지 주변 제외) */
  _randomSpot(minR = 25, maxDepth = -200, minDepth = 0) {
    for (let k = 0; k < 40; k++) {
      const x = (this.rand() - 0.5) * 2 * 255, z = (this.rand() - 0.5) * 2 * 255;
      if (Math.hypot(x, z) < minR) continue;
      const h = this.heightAt(x, z);
      if (h < maxDepth || h > minDepth) continue;
      return new THREE.Vector3(x, h, z);
    }
    return null;
  }

  _scatterRocks() {
    // 노이즈로 찌그러뜨린 이십면체 → 로우폴리 바위
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const p = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const d = 1 + this.noise.noise2D(v.x * 1.7 + v.z, v.y * 1.7 - v.z) * 0.28;
      v.multiplyScalar(d);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const mat = this.ocean.applyCaustics(new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.9 }));

    const count = 190;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), e = new THREE.Euler();
    const col = new THREE.Color();
    let n = 0;
    for (let i = 0; i < count; i++) {
      const spot = this._randomSpot(28);
      if (!spot) continue;
      const tall = this.rand() < 0.15; // 일부는 높은 바위 기둥
      const base = 2 + this.rand() * 5;
      s.set(base * (0.8 + this.rand() * 0.5), tall ? base * (2.5 + this.rand() * 2) : base * (0.6 + this.rand() * 0.6), base * (0.8 + this.rand() * 0.5));
      e.set(this.rand() * 0.4, this.rand() * Math.PI * 2, this.rand() * 0.4);
      q.setFromEuler(e);
      spot.y += s.y * 0.35; // 일부 묻힘
      m.compose(spot, q, s);
      mesh.setMatrixAt(n, m);
      col.setHSL(0.08 + this.rand() * 0.08, 0.08 + this.rand() * 0.1, 0.32 + this.rand() * 0.18);
      mesh.setColorAt(n, col);
      n++;
      // 충돌 구: 높은 바위는 구 여러 개를 쌓음
      const r = Math.min(s.x, s.z) * 0.85;
      if (tall) {
        const layers = Math.ceil(s.y / r);
        for (let k = 0; k < layers; k++) {
          this.obstacles.push({ pos: new THREE.Vector3(spot.x, spot.y - s.y * 0.6 + (k + 0.5) * (s.y * 1.6 / layers), spot.z), r });
        }
      } else {
        this.obstacles.push({ pos: spot.clone(), r: (s.x + s.y + s.z) / 3 * 0.9 });
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  _scatterCoral() {
    // 두 종류: 가지 산호(원뿔), 덩어리 산호(십이면체)
    const palette = [0xff6f91, 0xff9f43, 0xb06bff, 0xffd84d, 0xff4f6d, 0x4fe0c4];
    const kinds = [
      { geo: new THREE.ConeGeometry(0.5, 2.6, 5), count: 260, sy: [1, 2.2] },
      { geo: new THREE.DodecahedronGeometry(1, 0), count: 220, sy: [0.6, 1.1] },
    ];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), e = new THREE.Euler();
    const col = new THREE.Color();
    for (const k of kinds) {
      const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7, emissive: 0x220011, emissiveIntensity: 0.3 });
      const mesh = new THREE.InstancedMesh(k.geo, mat, k.count);
      let n = 0;
      for (let i = 0; i < k.count; i++) {
        // 산호는 군락을 이루며 얕은 곳(-75m 위)에 주로 자람
        const spot = this._randomSpot(18, -75);
        if (!spot) continue;
        const cluster = 1 + Math.floor(this.rand() * 3);
        for (let c = 0; c < cluster && n < k.count; c++) {
          const x = spot.x + (this.rand() - 0.5) * 6, z = spot.z + (this.rand() - 0.5) * 6;
          const sc = 0.6 + this.rand() * 1.0;
          s.set(sc, sc * (k.sy[0] + this.rand() * (k.sy[1] - k.sy[0])), sc);
          e.set((this.rand() - 0.5) * 0.5, this.rand() * 6.28, (this.rand() - 0.5) * 0.5);
          q.setFromEuler(e);
          m.compose(new THREE.Vector3(x, this.heightAt(x, z) + s.y * 0.6, z), q, s);
          mesh.setMatrixAt(n, m);
          col.setHex(palette[Math.floor(this.rand() * palette.length)]);
          mesh.setColorAt(n, col);
          n++;
        }
      }
      mesh.count = n;
      this.scene.add(mesh);
    }
  }

  _scatterSeaweed() {
    // 얇은 띠를 세워 셰이더에서 흔들리게 함
    const geo = new THREE.PlaneGeometry(0.7, 6, 1, 6);
    geo.translate(0, 3, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3f9b4a, side: THREE.DoubleSide, flatShading: true, roughness: 0.8 });
    this.seaweedUniforms = { uTime: { value: 0 } };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.seaweedUniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          float hgt = position.y / 6.0;
          float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
          transformed.x += sin(uTime * 1.3 + ph + hgt * 2.0) * hgt * hgt * 1.1;
          transformed.z += cos(uTime * 1.1 + ph * 1.3) * hgt * hgt * 0.6;`);
    };
    const count = 1400;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const col = new THREE.Color();
    let n = 0;
    while (n < count) {
      const spot = this._randomSpot(20, -85);
      if (!spot) break;
      const patch = 6 + Math.floor(this.rand() * 14); // 해초 숲
      for (let i = 0; i < patch && n < count; i++) {
        const x = spot.x + (this.rand() - 0.5) * 10, z = spot.z + (this.rand() - 0.5) * 10;
        const sc = 0.6 + this.rand() * 1.1;
        s.set(sc, sc * (0.7 + this.rand() * 0.8), sc);
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.rand() * Math.PI);
        m.compose(new THREE.Vector3(x, this.heightAt(x, z) - 0.2, z), q, s);
        mesh.setMatrixAt(n, m);
        col.setHSL(0.24 + this.rand() * 0.1, 0.5, 0.25 + this.rand() * 0.15);
        mesh.setColorAt(n, col);
        n++;
      }
    }
    mesh.count = n;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  _placeWreck(gltf) {
    const x = -150, z = 115;
    const y = this.heightAt(x, z);
    const yaw = 0.7;
    let wreck;
    if (gltf) {
      wreck = fitModel(gltf.scene, 34);
    } else {
      // 대체 난파선: 상자들로 기울어진 선체 구성
      wreck = new THREE.Group();
      const wood = this.ocean.applyCaustics(new THREE.MeshStandardMaterial({ color: 0x5a4632, flatShading: true, roughness: 0.95, side: THREE.DoubleSide }));
      const rust = new THREE.MeshStandardMaterial({ color: 0x6e4a36, flatShading: true, roughness: 0.9, metalness: 0.3 });
      const hull = new THREE.Mesh(new THREE.CylinderGeometry(5, 3.2, 30, 7, 1, false, -Math.PI / 2, Math.PI), wood);
      hull.rotation.set(Math.PI / 2, 0, 0); // 반원통을 눕혀 배 바닥 모양
      hull.position.y = 2.5;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.4, 28), wood);
      deck.position.y = 2.4;
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 7), wood);
      cabin.position.set(0, 4.6, -7);
      const bow = new THREE.Mesh(new THREE.ConeGeometry(4.8, 7, 7, 1, false, -Math.PI / 2, Math.PI), wood);
      bow.rotation.set(Math.PI / 2, 0, 0);
      bow.position.set(0, 2.5, 18.4);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 16, 6), rust);
      mast.position.set(0, 9, 4);
      mast.rotation.z = 0.5;
      const mast2 = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 7, 6), rust); // 부러진 돛대
      mast2.position.set(4, 1.5, -1);
      mast2.rotation.set(1.2, 0, 1.4);
      wreck.add(hull, deck, cabin, bow, mast, mast2);
    }
    wreck.position.set(x, y + 0.5, z);
    wreck.rotation.set(0.08, yaw, 0.22); // 옆으로 기울어진 채 가라앉음
    this.scene.add(wreck);
    this.wreckPosition = new THREE.Vector3(x, y, z);
    // 충돌 구: 선체 길이를 따라 배치
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    for (let k = -2; k <= 2; k++) {
      this.obstacles.push({ pos: new THREE.Vector3(x, y + 3, z).addScaledVector(dir, k * 7), r: 5 });
    }
  }

  update(dt) {
    this.time += dt;
    this.seaweedUniforms.uTime.value = this.time;
  }
}
