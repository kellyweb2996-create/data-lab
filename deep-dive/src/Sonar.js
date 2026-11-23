// =====================================================================
// Sonar — Q 키로 음파 발사
//   · 퍼져 나가는 구형 파동(프레넬 셰이더) + 수평 링
//   · 범위 안 보물/상어를 레이더에 잠깐 표시 (쿨타임 5초)
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';

export class Sonar {
  constructor(scene) {
    this.cooldown = 0;
    this.waveT = -1;      // 파동 진행도 (0~1), 음수면 비활성
    this.origin = new THREE.Vector3();
    this.marks = [];      // { pos, type, until }
    this.time = 0;

    // 구형 파동: 가장자리만 빛나는 프레넬 셰이더
    this.shellMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0x6ff7ff) } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
        void main(){
          float f = pow(1.0 - abs(dot(vN, vV)), 3.0);
          gl_FragColor = vec4(uColor, f * uOpacity);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.shell = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), this.shellMat);
    this.shell.visible = false;
    this.shell.frustumCulled = false;

    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x8ff9ff, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.frustumCulled = false;
    scene.add(this.shell, this.ring);
  }

  get ready() { return this.cooldown <= 0; }

  /**
   * 소나 발사. 범위 안 대상들을 marks에 등록하고 [{pos, dist, type}] 반환
   * @param targets [{ position, type: 'treasure'|'shark' }]
   */
  fire(origin, targets) {
    if (!this.ready) return null;
    const { range, cooldown, revealTime } = CONFIG.sonar;
    this.cooldown = cooldown;
    this.waveT = 0;
    this.origin.copy(origin);
    const found = [];
    for (const t of targets) {
      const d = t.position.distanceTo(origin);
      if (d <= range) {
        // 파동이 닿는 시점부터 표시되도록 지연
        const delay = (d / range) * CONFIG.sonar.waveTime;
        this.marks.push({ pos: t.position.clone(), ref: t.type === 'shark' ? t.position : null, type: t.type, from: this.time + delay, until: this.time + delay + revealTime });
        found.push({ dist: d, type: t.type });
      }
    }
    return found;
  }

  reset() {
    this.cooldown = 0; this.waveT = -1; this.marks = [];
    this.shell.visible = this.ring.visible = false;
  }

  update(dt) {
    this.time += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.marks = this.marks.filter((m) => m.until > this.time);
    for (const m of this.marks) if (m.ref) m.pos.copy(m.ref); // 상어는 움직임을 따라감

    if (this.waveT >= 0) {
      this.waveT += dt / CONFIG.sonar.waveTime;
      const t = this.waveT;
      if (t >= 1) {
        this.waveT = -1;
        this.shell.visible = this.ring.visible = false;
        return;
      }
      const r = 2 + (CONFIG.sonar.range - 2) * (1 - Math.pow(1 - t, 2)); // 처음에 빠르게
      this.shell.visible = this.ring.visible = true;
      this.shell.position.copy(this.origin);
      this.shell.scale.setScalar(r);
      this.ring.position.copy(this.origin);
      this.ring.scale.setScalar(r);
      this.shellMat.uniforms.uOpacity.value = (1 - t) * 0.9;
      this.ringMat.opacity = (1 - t) * 0.6;
    }
  }
}
