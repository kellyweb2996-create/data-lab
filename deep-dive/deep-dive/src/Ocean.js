// =====================================================================
// Ocean — 수중 환경 연출
//   · 수심에 따라 색/밀도가 바뀌는 지수 안개(FogExp2)와 조명
//   · 수면(아래에서 올려다본 물결), 빛줄기(god rays)
//   · 해저 물빛 일렁임(caustics) 셰이더 패치
//   · 부유물 파티클, 거품 파티클
//   · 수면 기지
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, smoothstep, makeGlowTexture, makeRayTexture, makeCausticTexture, mulberry32 } from './utils.js';

const SHALLOW_COLOR = new THREE.Color(0x1d8fa0); // 수면 근처 청록색
const MID_COLOR = new THREE.Color(0x0b3d63);
const DEEP_COLOR = new THREE.Color(0x01050d);    // 심해 남색
const BUBBLE_MAX = 500;

export class Ocean {
  constructor(scene, assets) {
    this.scene = scene;
    this.time = 0;
    this.glowTexture = makeGlowTexture();

    // ---- 안개 & 배경 ----
    this.fogColor = SHALLOW_COLOR.clone();
    scene.fog = new THREE.FogExp2(this.fogColor, 0.01);
    scene.background = this.fogColor;

    // ---- 조명 ----
    this.hemi = new THREE.HemisphereLight(0xa8f0ff, 0x0b2a3a, 1.4);
    this.sun = new THREE.DirectionalLight(0xdffaff, 2.2);
    this.sun.position.set(40, 100, 20);
    scene.add(this.hemi, this.sun, this.sun.target);

    // ---- caustics 공용 유니폼 (지형/바위 머티리얼에 주입) ----
    this.causticFrames = assets.caustics;            // 프레임 배열 또는 null
    const fallback = this.causticFrames ? null : makeCausticTexture(mulberry32(7));
    this.causticUniforms = {
      uCaustic: { value: this.causticFrames ? this.causticFrames[0] : fallback },
      uCTime: { value: 0 },
      uCStrength: { value: 1.0 },
    };

    this._buildSurface();
    this._buildGodRays();
    this._buildMarineSnow();
    this._buildBubbles();
    this._buildBase();
  }

  /**
   * MeshStandardMaterial에 caustics를 주입한다.
   * 월드 XZ 좌표로 텍스처를 투영하고, 얕을수록 강하게 비춘다.
   */
  applyCaustics(material) {
    const u = this.causticUniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCWorld;')
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          vec4 cw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            cw = instanceMatrix * cw;
          #endif
          vCWorld = (modelMatrix * cw).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`#include <common>
          varying vec3 vCWorld;
          uniform sampler2D uCaustic; uniform float uCTime; uniform float uCStrength;`)
        .replace('#include <opaque_fragment>', /* glsl */`
          {
            float depthFade = clamp(1.0 + vCWorld.y / 85.0, 0.0, 1.0);
            vec2 cuv = vCWorld.xz * 0.045;
            float c1 = texture2D(uCaustic, cuv + vec2(uCTime * 0.021, uCTime * 0.013)).r;
            float c2 = texture2D(uCaustic, cuv * 1.37 + vec2(-uCTime * 0.016, uCTime * 0.019)).r;
            float caust = min(c1, c2) * 2.2 + c1 * 0.25;
            outgoingLight += diffuseColor.rgb * caust * uCStrength * depthFade * depthFade;
          }
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => 'caustics';
    return material;
  }

  // ---- 수면: 아래에서 올려다본 반짝이는 물결 ---------------------------
  _buildSurface() {
    const geo = new THREE.PlaneGeometry(1400, 1400, 70, 70);
    geo.rotateX(Math.PI / 2); // 아래(-Y)를 향하게
    this.surfaceMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 },
        uBright: { value: new THREE.Color(0xbff6ff) },
        uDeep: { value: new THREE.Color(0x2aa7b8) },
      }]),
      vertexShader: /* glsl */`
        uniform float uTime; varying vec3 vW;
        #include <fog_pars_vertex>
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0);
          w.y += sin(w.x * 0.08 + uTime) * 0.35 + cos(w.z * 0.1 + uTime * 1.3) * 0.35;
          vW = w.xyz;
          vec4 mvPosition = viewMatrix * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform vec3 uBright; uniform vec3 uDeep; varying vec3 vW;
        #include <fog_pars_fragment>
        void main(){
          float n = sin(vW.x * 0.15 + uTime * 0.7) * sin(vW.z * 0.13 - uTime * 0.5)
                  + 0.5 * sin((vW.x + vW.z) * 0.31 + uTime * 1.1);
          vec3 col = mix(uDeep, uBright, smoothstep(-1.2, 1.4, n));
          gl_FragColor = vec4(col, 0.92);
          #include <fog_fragment>
        }`,
      fog: true, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    });
    this.surface = new THREE.Mesh(geo, this.surfaceMat);
    this.surface.position.y = 0;
    this.surface.renderOrder = -1;
    this.scene.add(this.surface);
  }

  // ---- 빛줄기: 카메라를 향하는 세로 판들을 가산 혼합 -------------------
  _buildGodRays() {
    const tex = makeRayTexture();
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, -0.5, 0); // 윗변이 원점 → 수면에서 아래로 뻗음
    this.rays = [];
    for (let i = 0; i < 18; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex, color: 0xcff8ff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: true,
      });
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(3 + Math.random() * 7, 45 + Math.random() * 40, 1);
      m.userData = { phase: Math.random() * 10, base: 0.12 + Math.random() * 0.16 };
      m.position.set((Math.random() - 0.5) * 140, -0.5, (Math.random() - 0.5) * 140);
      this.rays.push(m);
      this.scene.add(m);
    }
  }

  // ---- 부유물(marine snow): 셰이더에서 카메라 주변으로 무한 반복 -------
  _buildMarineSnow() {
    const N = 2200, BOX = 90;
    const pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = Math.random() * BOX; pos[i * 3 + 1] = Math.random() * BOX; pos[i * 3 + 2] = Math.random() * BOX;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.snowMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uBox: { value: BOX },
        uColor: { value: new THREE.Color(0xd8f4ff) }, uBright: { value: 1 },
        uPixel: { value: 1 },
      }]),
      vertexShader: /* glsl */`
        uniform vec3 uCam; uniform float uTime; uniform float uBox; uniform float uPixel;
        attribute float aSeed; varying float vAlpha;
        #include <fog_pars_vertex>
        void main(){
          vec3 p = position + vec3(sin(uTime * 0.3 + aSeed * 6.28) * 0.6, -uTime * (0.15 + aSeed * 0.2), cos(uTime * 0.23 + aSeed * 3.0) * 0.6);
          p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
          vec4 mvPosition = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = min(uPixel * (0.6 + aSeed * 1.4) * (50.0 / max(1.0, -mvPosition.z)), 10.0 * uPixel);
          vAlpha = 1.0 - smoothstep(uBox * 0.3, uBox * 0.5, length(p - uCam));
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uBright; varying float vAlpha;
        #include <fog_pars_fragment>
        void main(){
          float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
          gl_FragColor = vec4(uColor * uBright, a * vAlpha * 0.65);
          #include <fog_fragment>
        }`,
      fog: true, transparent: true, depthWrite: false,
    });
    this.snow = new THREE.Points(geo, this.snowMat);
    this.snow.frustumCulled = false;
    this.scene.add(this.snow);
  }

  // ---- 거품 파티클 풀 -------------------------------------------------
  _buildBubbles() {
    this.bubblePos = new Float32Array(BUBBLE_MAX * 3);
    this.bubbleVel = new Float32Array(BUBBLE_MAX * 3);
    this.bubbleLife = new Float32Array(BUBBLE_MAX);  // 남은 수명 (초)
    this.bubbleMaxLife = new Float32Array(BUBBLE_MAX);
    this.bubbleAlpha = new Float32Array(BUBBLE_MAX);
    this.bubbleSize = new Float32Array(BUBBLE_MAX);
    this.bubbleCursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.bubblePos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.bubbleAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.bubbleSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.bubbleMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPixel: { value: 1 }, uBright: { value: 1 } }]),
      vertexShader: /* glsl */`
        attribute float aAlpha; attribute float aSize; uniform float uPixel; varying float vA;
        #include <fog_pars_vertex>
        void main(){
          vA = aAlpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = min(uPixel * aSize * (120.0 / max(1.0, -mvPosition.z)), 28.0 * uPixel);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        varying float vA; uniform float uBright;
        #include <fog_pars_fragment>
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float ring = smoothstep(0.32, 0.5, d) * (1.0 - smoothstep(0.45, 0.5, d)) + 0.12;
          float hi = smoothstep(0.18, 0.0, length(gl_PointCoord - vec2(0.36, 0.32)));
          gl_FragColor = vec4(vec3(0.85, 0.97, 1.0) * uBright, (ring + hi) * vA);
          #include <fog_fragment>
        }`,
      fog: true, transparent: true, depthWrite: false,
    });
    this.bubbles = new THREE.Points(geo, this.bubbleMat);
    this.bubbles.frustumCulled = false;
    this.scene.add(this.bubbles);
  }

  /** 거품 방출: pos 주변 spread 범위, vel 기본 속도 */
  emitBubbles(pos, count, spread = 0.4, vel = null) {
    for (let n = 0; n < count; n++) {
      const i = this.bubbleCursor;
      this.bubbleCursor = (this.bubbleCursor + 1) % BUBBLE_MAX;
      this.bubblePos[i * 3] = pos.x + (Math.random() - 0.5) * spread;
      this.bubblePos[i * 3 + 1] = pos.y + (Math.random() - 0.5) * spread;
      this.bubblePos[i * 3 + 2] = pos.z + (Math.random() - 0.5) * spread;
      this.bubbleVel[i * 3] = (vel ? vel.x : 0) + (Math.random() - 0.5) * 0.8;
      this.bubbleVel[i * 3 + 1] = (vel ? vel.y : 0) + 1.5 + Math.random() * 1.5;
      this.bubbleVel[i * 3 + 2] = (vel ? vel.z : 0) + (Math.random() - 0.5) * 0.8;
      const life = 1.5 + Math.random() * 2;
      this.bubbleLife[i] = this.bubbleMaxLife[i] = life;
      this.bubbleSize[i] = 0.15 + Math.random() * 0.3;
    }
  }

  _updateBubbles(dt) {
    const p = this.bubblePos, v = this.bubbleVel;
    for (let i = 0; i < BUBBLE_MAX; i++) {
      if (this.bubbleLife[i] <= 0) { this.bubbleAlpha[i] = 0; continue; }
      this.bubbleLife[i] -= dt;
      // 물의 저항으로 수평 속도는 줄고, 부력으로 위로 가속
      const k = Math.exp(-2.5 * dt);
      v[i * 3] *= k; v[i * 3 + 2] *= k;
      v[i * 3 + 1] = Math.min(v[i * 3 + 1] + 2.0 * dt, 4.5);
      p[i * 3] += (v[i * 3] + Math.sin(this.time * 8 + i) * 0.3) * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      if (p[i * 3 + 1] > -0.3) this.bubbleLife[i] = 0; // 수면에서 터짐
      const t = this.bubbleLife[i] / this.bubbleMaxLife[i];
      this.bubbleAlpha[i] = Math.min(1, t * 3) * 0.9;
      this.bubbleSize[i] += dt * 0.08;
    }
    const g = this.bubbles.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  // ---- 수면 기지 -------------------------------------------------------
  _buildBase() {
    const g = new THREE.Group();
    const yellow = new THREE.MeshStandardMaterial({ color: 0xffb02e, roughness: 0.6, flatShading: true });
    const gray = new THREE.MeshStandardMaterial({ color: 0x5c6b77, roughness: 0.7, metalness: 0.4, flatShading: true });
    this.dockLightMat = new THREE.MeshBasicMaterial({ color: 0x5ff6ff });

    // 갑판: 수면 위는 노란색, 물 아래 부유체는 회색 (아래에서 올려다볼 때 눈부시지 않게)
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 0.8, 8), yellow);
    deck.position.y = 0.9;
    const pontoon = new THREE.Mesh(new THREE.CylinderGeometry(10, 9, 1.2, 8), gray);
    pontoon.position.y = -0.1;
    g.add(pontoon);
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 3, 5, 8), gray);
    hull.position.y = -2.6;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 7, 6), gray);
    tower.position.y = 4.5;
    g.add(deck, hull, tower);

    // 부표
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const buoy = new THREE.Mesh(new THREE.SphereGeometry(1.1, 6, 5), yellow);
      buoy.position.set(Math.cos(a) * 10.5, -0.2, Math.sin(a) * 10.5);
      g.add(buoy);
    }

    // 도킹 링 (깜빡이는 표시등)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(7, 0.35, 6, 24), this.dockLightMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -6.5;
    g.add(ring);
    // 아래로 늘어진 케이블 + 표시등
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6, 4), gray);
      cable.position.set(Math.cos(a) * 7, -3.5, Math.sin(a) * 7);
      g.add(cable);
    }
    this.baseLight = new THREE.PointLight(0x5ff6ff, 6, 40, 1.0);
    this.baseLight.position.y = -9;
    g.add(this.baseLight);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture, color: 0x5ff6ff, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.scale.setScalar(26);
    glow.position.y = -6.5;
    g.add(glow);
    this.baseGlow = glow;

    this.base = g;
    this.basePosition = new THREE.Vector3(0, 0, 0);
    this.scene.add(g);
  }

  /** 기지 도킹 범위 안인지 */
  isAtBase(pos) {
    const dx = pos.x - this.basePosition.x, dz = pos.z - this.basePosition.z;
    return dx * dx + dz * dz < CONFIG.base.radius ** 2 && pos.y > -CONFIG.base.maxDepth;
  }

  setPixelRatio(pr) {
    this.snowMat.uniforms.uPixel.value = pr;
    this.bubbleMat.uniforms.uPixel.value = pr;
  }

  /**
   * 매 프레임 갱신
   * @param camera   현재 카메라 (안개/빛줄기 기준)
   * @param lightOn  탐조등 상태 (부유물이 빛을 받아 보이게)
   */
  update(dt, camera, lightOn) {
    this.time += dt;
    const t = this.time;
    const depth = Math.max(0, -camera.position.y);

    // ---- 수심에 따른 안개/조명: 깊을수록 어둡고 시야가 짧음 ----
    const d = clamp(depth / 110, 0, 1);
    if (d < 0.45) this.fogColor.copy(SHALLOW_COLOR).lerp(MID_COLOR, d / 0.45);
    else this.fogColor.copy(MID_COLOR).lerp(DEEP_COLOR, smoothstep(0.45, 1, d));
    this.scene.fog.color.copy(this.fogColor);
    this.scene.fog.density = lerp(0.0095, 0.03, Math.pow(d, 0.8));
    const light = Math.pow(1 - d, 2.2);
    this.hemi.intensity = 0.04 + 1.2 * light;
    this.sun.intensity = 1.7 * light;
    this.causticUniforms.uCStrength.value = 0.9 * (0.15 + 0.85 * light);

    // ---- caustics 애니메이션 ----
    this.causticUniforms.uCTime.value = t;
    if (this.causticFrames) {
      const idx = Math.floor(t * 20) % this.causticFrames.length;
      this.causticUniforms.uCaustic.value = this.causticFrames[idx];
    }

    // ---- 수면 ----
    this.surfaceMat.uniforms.uTime.value = t;

    // ---- 빛줄기: 수면 가까울수록 진하게, 카메라 주변에 재배치 ----
    const rayFade = 1 - smoothstep(8, 65, depth);
    const cp = camera.position;
    for (const r of this.rays) {
      const dx = r.position.x - cp.x, dz = r.position.z - cp.z;
      if (dx * dx + dz * dz > 75 * 75) {
        const a = Math.random() * Math.PI * 2, rr = 20 + Math.random() * 50;
        r.position.x = cp.x + Math.cos(a) * rr;
        r.position.z = cp.z + Math.sin(a) * rr;
      }
      r.rotation.y = Math.atan2(cp.x - r.position.x, cp.z - r.position.z); // Y축 빌보드
      const u = r.userData;
      r.material.opacity = rayFade * u.base * (0.6 + 0.4 * Math.sin(t * 0.6 + u.phase));
      r.visible = r.material.opacity > 0.003;
    }

    // ---- 파티클 ----
    this.snowMat.uniforms.uCam.value.copy(cp);
    this.snowMat.uniforms.uTime.value = t;
    const bright = 0.12 + 0.88 * light + (lightOn ? 0.45 : 0);
    this.snowMat.uniforms.uBright.value = bright;
    this.bubbleMat.uniforms.uBright.value = Math.min(1, bright + 0.2);
    this._updateBubbles(dt);

    // ---- 기지 표시등 깜빡임 ----
    const blink = 0.55 + 0.45 * Math.sin(t * 3);
    this.dockLightMat.color.setRGB(0.37 * blink + 0.1, 0.96 * blink + 0.04, 1.0 * blink);
    this.baseGlow.material.opacity = 0.4 + 0.4 * blink;
  }
}
