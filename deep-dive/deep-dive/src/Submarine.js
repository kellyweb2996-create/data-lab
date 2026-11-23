// =====================================================================
// Submarine — 잠수함 모델 + 직접 구현한 수중 물리
//   · 추력 → 속도 → 위치 (관성)
//   · 방향별로 다른 물 저항(drag): 옆으로 잘 안 미끄러지는 용골 효과
//   · 밸러스트 탱크: 상승/하강 입력이 서서히 차오르는 부력으로 변환
//   · 로컬 좌표계: +Z가 앞, +Y가 위
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, damp, fitModel } from './utils.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Submarine {
  constructor(scene, gltf) {
    this.group = new THREE.Group();      // 위치 + 진행 방향(yaw)
    this.tiltGroup = new THREE.Group();  // 피치/롤 기울기 (시각 효과)
    this.model = new THREE.Group();      // 1인칭에서 숨길 선체
    this.group.add(this.tiltGroup);
    this.tiltGroup.add(this.model);
    scene.add(this.group);

    this.position = this.group.position;
    this.velocity = new THREE.Vector3();
    this.heading = 0;   // yaw (rad). 0이면 +Z를 바라봄
    this.yawVel = 0;
    this.ballast = 0;   // -1(하강) ~ 1(상승)
    this.pitch = 0;
    this.roll = 0;
    this.propAngle = 0;
    this.propeller = null;
    this.lightOn = false;

    if (gltf) this._useGLTF(gltf);
    else this._buildFallback();

    this._buildSearchlight();
  }

  // ---- glTF 모델 사용 -------------------------------------------------
  _useGLTF(gltf) {
    const obj = gltf.scene;
    obj.traverse((o) => {
      if (o.isMesh) o.castShadow = false;
      if (!this.propeller && /prop|screw|propeller/i.test(o.name)) this.propeller = o;
    });
    this.model.add(fitModel(obj, 7.5));
  }

  // ---- 대체 모델: 캡슐 + 원기둥 ---------------------------------------
  _buildFallback() {
    const hullMat = new THREE.MeshStandardMaterial({ color: 0xf59a23, roughness: 0.55, metalness: 0.3, flatShading: true });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2f3a44, roughness: 0.6, metalness: 0.5, flatShading: true });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x7fe7ff, emissive: 0x1a6f86, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.2, flatShading: true });

    // 선체: 캡슐을 Z축 방향으로 눕힘
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 4.2, 4, 10), hullMat);
    hull.rotation.x = Math.PI / 2;
    this.model.add(hull);

    // 조종탑(원기둥)
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 1.1, 8), hullMat);
    tower.position.set(0, 1.3, 0.6);
    this.model.add(tower);
    const periscope = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 6), darkMat);
    periscope.position.set(0, 2.1, 0.75);
    this.model.add(periscope);

    // 앞 유리창(조종석)
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.75, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    dome.rotation.x = Math.PI / 2;
    dome.position.set(0, 0.25, 2.9);
    this.model.add(dome);

    // 측면 창문
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.1, 8), glassMat);
        w.rotation.z = Math.PI / 2;
        w.position.set(side * 1.12, 0.2, 1.2 - i * 0.9);
        this.model.add(w);
      }
    }

    // 꼬리 날개 (수평/수직)
    const finH = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.08, 0.8), darkMat);
    finH.position.set(0, 0, -2.6);
    const finV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.0, 0.8), darkMat);
    finV.position.set(0, 0, -2.6);
    this.model.add(finH, finV);

    // 앞쪽 잠항타
    const bowFin = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.06, 0.5), darkMat);
    bowFin.position.set(0, 1.25, 0.6);
    this.model.add(bowFin);

    // 프로펠러: 허브 + 날개 4장
    const prop = new THREE.Group();
    prop.position.set(0, 0, -3.35);
    const hub = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 8), darkMat);
    hub.rotation.x = -Math.PI / 2;
    prop.add(hub);
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.85, 0.05), darkMat);
      blade.position.y = 0.42;
      blade.rotation.y = 0.5;
      const pivot = new THREE.Group();
      pivot.rotation.z = (i / 4) * Math.PI * 2;
      pivot.add(blade);
      prop.add(pivot);
    }
    this.model.add(prop);
    this.propeller = prop;

    // 프로펠러 보호 링
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.07, 6, 16), darkMat);
    ring.position.set(0, 0, -3.35);
    this.model.add(ring);
  }

  // ---- 탐조등 (SpotLight) + 눈에 보이는 빛 원뿔 -----------------------
  _buildSearchlight() {
    // 물리 기반 조명이라 강도(칸델라)를 크게 잡음
    this.spot = new THREE.SpotLight(0xfff1cc, 0, 120, 0.42, 0.55, 0.85);
    this.spot.position.set(0, -0.3, 3.4);
    this.spot.target.position.set(0, -2.5, 30);
    this.tiltGroup.add(this.spot, this.spot.target);

    // 램프
    const lamp = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.2, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff6d8 })
    );
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(0, -0.55, 3.25);
    this.lampMesh = lamp;
    this.model.add(lamp);

    // 산란광 원뿔 (가산 혼합 반투명)
    const coneGeo = new THREE.ConeGeometry(9, 34, 20, 1, true);
    coneGeo.translate(0, -17, 0);
    coneGeo.rotateX(-Math.PI / 2); // 꼭짓점이 원점, +Z로 퍼짐
    const coneMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.0 } },
      vertexShader: /* glsl */`
        varying float vZ; varying vec3 vN; varying vec3 vV;
        void main(){
          vZ = position.z / 34.0;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; varying float vZ; varying vec3 vN; varying vec3 vV;
        void main(){
          float edge = pow(abs(dot(vN, vV)), 1.5);
          float a = (1.0 - vZ) * (1.0 - vZ) * edge * uOpacity;
          gl_FragColor = vec4(1.0, 0.95, 0.8, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(coneGeo, coneMat);
    this.beam.position.copy(this.spot.position);
    this.beam.lookAt(this.spot.target.position); // 원뿔을 탐조등 방향으로
    this.beam.visible = false;
    this.tiltGroup.add(this.beam);
  }

  setLight(on) {
    this.lightOn = on;
    this.spot.intensity = on ? 55 : 0;
    this.beam.visible = on;
    this.lampMesh.material.color.setHex(on ? 0xfff6d8 : 0x444444);
  }

  getForward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }
  getRight(out = new THREE.Vector3()) {
    return out.set(-Math.cos(this.heading), 0, Math.sin(this.heading));
  }
  /** 프로펠러 위치(월드) — 거품 방출용 */
  getPropellerWorld(out = new THREE.Vector3()) {
    return this.tiltGroup.localToWorld(out.set(0, 0, -3.6));
  }

  reset(pos, heading = 0) {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.heading = heading;
    this.yawVel = 0; this.ballast = 0; this.pitch = 0; this.roll = 0;
    this.setLight(false);
    this.update(0, { thrust: 0, turn: 0, vertical: 0 }, 1, 0);
  }

  /**
   * @param input  { thrust:-1..1, turn:-1..1, vertical:-1..1 }
   * @param power  배터리 상태에 따른 추력 배율 (1 또는 0.4)
   */
  update(dt, input, power, time) {
    const c = CONFIG.sub;

    // 1) 회전: 각가속도 + 감쇠 → 키를 떼도 천천히 멈춤
    this.yawVel += input.turn * c.yawAccel * power * dt;
    this.yawVel *= Math.exp(-c.yawDrag * dt);
    this.heading += this.yawVel * dt;

    // 2) 밸러스트 탱크: 목표치까지 일정 속도로만 변함 (부드러운 상승/하강)
    const step = c.ballastRate * dt;
    this.ballast += clamp(input.vertical - this.ballast, -step, step);

    // 3) 추력 + 부력
    const fwd = this.getForward(_fwd);
    const right = this.getRight(_right);
    const thrust = input.thrust * c.thrust * (input.thrust < 0 ? c.reverseFactor : 1) * power;
    this.velocity.addScaledVector(fwd, thrust * dt);
    this.velocity.y += this.ballast * c.buoyAccel * dt;

    // 4) 물 저항: 속도를 앞/옆/위 성분으로 나눠 각각 다른 감쇠 적용
    const speed = this.velocity.length();
    const q = c.quadDrag * speed;
    const vf = this.velocity.dot(fwd) * Math.exp(-(c.forwardDrag + q) * dt);
    const vl = this.velocity.dot(right) * Math.exp(-(c.lateralDrag + q) * dt);
    const vy = this.velocity.y * Math.exp(-(c.verticalDrag + q) * dt);
    this.velocity.set(0, vy, 0).addScaledVector(fwd, vf).addScaledVector(right, vl);

    // 5) 적분
    this.position.addScaledVector(this.velocity, dt);

    // 6) 수면 위로는 못 나감
    if (this.position.y > c.maxSurfaceY) {
      this.position.y = c.maxSurfaceY;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }

    // 7) 선체 기울기: 상승 시 기수 들림, 회전 시 안쪽으로 기울어짐
    const targetPitch = clamp(-this.velocity.y * 0.06 - this.ballast * 0.1, -0.4, 0.4);
    const targetRoll = clamp(-this.yawVel * (0.15 + Math.abs(vf) * 0.04), -0.45, 0.45);
    this.pitch += (targetPitch - this.pitch) * damp(3, dt);
    this.roll += (targetRoll - this.roll) * damp(3, dt);
    this.group.rotation.y = this.heading;
    this.tiltGroup.rotation.set(this.pitch, 0, this.roll);
    this.tiltGroup.position.y = Math.sin(time * 1.3) * 0.06; // 미세한 출렁임

    // 8) 프로펠러: 전진 속도 + 추력 입력에 비례해 회전
    this.propAngle += (vf * 1.4 + input.thrust * 8 * power) * dt;
    if (this.propeller) this.propeller.rotation.z = this.propAngle;

    // 탐조등 산란광 깜빡임
    if (this.lightOn) this.beam.material.uniforms.uOpacity.value = 0.11 + Math.sin(time * 7) * 0.005;

    this.forwardSpeed = vf;
  }
}
