// =====================================================================
// Ocean — 수중 환경 연출
//   · 수심에 따라 색/밀도가 바뀌는 지수 안개(FogExp2)와 조명
//   · 수면(아래에서 올려다본 물결), 빛줄기(god rays: 가산 혼합 원뿔)
//   · 해저 물빛 일렁임(caustics): GLSL 보로노이 노이즈로 실시간 생성
//   · 부유물 파티클, 거품 파티클
//   · 수면 기지
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, smoothstep, makeGlowTexture } from './utils.js';

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
    this.causticUniforms = {
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
   * 셰이더 문자열에 caustics를 주입한다 (onBeforeCompile 안에서 호출).
   * 텍스처 없이 보로노이 노이즈 두 겹을 서로 다른 속도로 움직여 겹치고,
   * 위를 향한 면일수록, 얕을수록 강하게 비춘다.
   * 다른 셰이더 수정(모래 텍스처 등)과 함께 쓸 수 있도록 분리해 둠.
   */
  injectCaustics(shader) {
    Object.assign(shader.uniforms, this.causticUniforms);
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
        uniform float uCTime; uniform float uCStrength;

        vec2 cHash2(vec2 p) {
          p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
          return fract(sin(p) * 43758.5453);
        }
        // 보로노이: 가장 가까운 두 점까지 거리의 차(F2-F1) = 셀 경계까지의 거리
        float cVoronoiEdge(vec2 x, float t) {
          vec2 n = floor(x), f = fract(x);
          float f1 = 8.0, f2 = 8.0;
          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              vec2 g = vec2(float(i), float(j));
              vec2 o = cHash2(n + g);
              o = 0.5 + 0.42 * sin(t + 6.2831 * o); // 셀 중심이 제자리에서 맴돔
              vec2 r = g + o - f;
              float d = dot(r, r);
              if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
            }
          }
          return sqrt(f2) - sqrt(f1);
        }
        // 한 겹: 셀 경계가 밝은 빛 그물이 됨
        float cLayer(vec2 p, float t) {
          float e = cVoronoiEdge(p, t);
          return pow(clamp(1.0 - e * 2.4, 0.0, 1.0), 4.0);
        }
        float causticPattern(vec2 world, float t) {
          vec2 p = world * 0.32;
          p += 0.18 * vec2(sin(p.y * 1.7 + t * 0.8), cos(p.x * 1.3 + t * 0.6)); // 물결 왜곡
          float l1 = cLayer(p + vec2(t * 0.05, t * 0.03), t * 0.9);
          float l2 = cLayer(p * 1.43 + vec2(-t * 0.04, t * 0.06) + 17.0, t * 1.35);
          float c = (l1 + l2) * 0.55 + l1 * l2 * 1.6;
          // 멀리서 그물이 픽셀보다 가늘어지면 반짝임 대신 평균 밝기로
          float aa = 1.0 - smoothstep(0.12, 0.5, fwidth(p.x) + fwidth(p.y));
          return mix(0.22, c, aa);
        }`)
      .replace('#include <opaque_fragment>', /* glsl */`
        {
          float depthFade = clamp(1.0 + vCWorld.y / 85.0, 0.0, 1.0);   // 깊을수록 약하게
          vec3 wN = inverseTransformDirection(normal, viewMatrix);      // 월드 법선
          float facing = clamp(wN.y * 1.25 - 0.15, 0.0, 1.0);           // 위를 향한 면만
          float caust = causticPattern(vCWorld.xz, uCTime);
          outgoingLight += diffuseColor.rgb * vec3(0.9, 1.0, 1.06) * caust * uCStrength * depthFade * depthFade * facing;
        }
        #include <opaque_fragment>`);
  }

  /** caustics만 쓰는 머티리얼(바위·난파선)에 적용 */
  applyCaustics(material) {
    material.onBeforeCompile = (shader) => this.injectCaustics(shader);
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

  // ---- 빛줄기: 반투명 원뿔 여러 개를 가산 혼합, 천천히 흔들림 ----------
  _buildGodRays() {
    // 위가 좁고 아래로 퍼지는 열린 원뿔대. 윗면이 원점, 아래로 길이 1
    const geo = new THREE.CylinderGeometry(0.2, 1, 1, 20, 1, true);
    geo.translate(0, -0.5, 0);
    const base = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color(0xcff8ff) },
      }]),
      vertexShader: /* glsl */`
        varying float vH; varying vec3 vN; varying vec3 vV;
        #include <fog_pars_vertex>
        void main(){
          vH = -position.y; // 0(수면) ~ 1(끝)
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mvPosition.xyz);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform vec3 uColor;
        varying float vH; varying vec3 vN; varying vec3 vV;
        #include <fog_pars_fragment>
        void main(){
          float core = pow(abs(dot(normalize(vN), normalize(vV))), 2.2); // 가장자리는 부드럽게 사라짐
          float fade = pow(1.0 - vH, 1.7) * smoothstep(0.0, 0.05, vH);   // 아래로 갈수록 옅어짐
          float a = uOpacity * core * fade;
          #ifdef USE_FOG
            // 가산 혼합이라 안개색을 더하지 않고, 안개만큼 투명하게
            float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            a *= 1.0 - fogF;
          #endif
          gl_FragColor = vec4(uColor, a);
        }`,
      fog: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.rays = [];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(geo, base.clone());
      const r = 2 + Math.random() * 4.5;
      m.scale.set(r, 50 + Math.random() * 45, r);
      // 해가 +X, +Z 쪽에 있으므로 빛줄기 끝이 -X, -Z 로 비스듬히
      m.userData = {
        phase: Math.random() * 10, base: 0.08 + Math.random() * 0.1,
        tiltX: 0.12 + Math.random() * 0.06, tiltZ: -0.3 - Math.random() * 0.08,
      };
      m.position.set((Math.random() - 0.5) * 140, -0.3, (Math.random() - 0.5) * 140);
      m.frustumCulled = false;
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
        uPixel: { value: 1 }, uGlow: { value: 0 },
      }]),
      vertexShader: /* glsl */`
        uniform vec3 uCam; uniform float uTime; uniform float uBox; uniform float uPixel; uniform float uGlow;
        attribute float aSeed; varying float vAlpha; varying float vGlow;
        #include <fog_pars_vertex>
        void main(){
          vec3 p = position + vec3(sin(uTime * 0.3 + aSeed * 6.28) * 0.6, -uTime * (0.15 + aSeed * 0.2), cos(uTime * 0.23 + aSeed * 3.0) * 0.6);
          p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
          vec4 mvPosition = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = min(uPixel * (0.6 + aSeed * 1.4) * (50.0 / max(1.0, -mvPosition.z)), 10.0 * uPixel);
          vAlpha = 1.0 - smoothstep(uBox * 0.3, uBox * 0.5, length(p - uCam));
          // 약 5%는 심해에서 깜빡이며 빛나는 발광 플랑크톤
          vGlow = step(0.95, aSeed) * uGlow * (0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 40.0), 3.0));
          gl_PointSize *= 1.0 + vGlow * 1.5;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uBright; varying float vAlpha; varying float vGlow;
        #include <fog_pars_fragment>
        void main(){
          float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
          vec3 col = mix(uColor * uBright, vec3(0.35, 1.0, 0.9) * 3.0, vGlow); // 발광체는 HDR로 밝게 → 블룸
          gl_FragColor = vec4(col, a * vAlpha * mix(0.65, 1.0, vGlow));
          #include <fog_fragment>
          gl_FragColor.rgb = mix(gl_FragColor.rgb, col, vGlow * 0.7); // 발광은 안개를 뚫고 보이게
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

    // ---- caustics 애니메이션 (셰이더가 시간으로 직접 생성) ----
    this.causticUniforms.uCTime.value = t;

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
      // 수면을 축으로 천천히 흔들림
      const u = r.userData;
      r.rotation.set(u.tiltX + Math.sin(t * 0.23 + u.phase) * 0.05, 0, u.tiltZ + Math.cos(t * 0.19 + u.phase * 1.3) * 0.06);
      const op = rayFade * u.base * (0.6 + 0.4 * Math.sin(t * 0.6 + u.phase));
      r.material.uniforms.uOpacity.value = op;
      r.visible = op > 0.003;
    }

    // ---- 파티클 ----
    this.snowMat.uniforms.uCam.value.copy(cp);
    this.snowMat.uniforms.uTime.value = t;
    const bright = 0.12 + 0.88 * light + (lightOn ? 0.45 : 0);
    this.snowMat.uniforms.uBright.value = bright;
    this.snowMat.uniforms.uGlow.value = smoothstep(35, 85, depth);
    this.bubbleMat.uniforms.uBright.value = Math.min(1, bright + 0.2);
    this._updateBubbles(dt);

    // ---- 기지 표시등 깜빡임 ----
    const blink = 0.55 + 0.45 * Math.sin(t * 3);
    this.dockLightMat.color.setRGB(0.37 * blink + 0.1, 0.96 * blink + 0.04, 1.0 * blink).multiplyScalar(2.2); // 블룸
    this.baseGlow.material.opacity = 0.4 + 0.4 * blink;
  }
}
