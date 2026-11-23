// =====================================================================
// PostFX — 후처리 (EffectComposer)
//   RenderPass → UnrealBloomPass(탐조등·발광체가 은은하게 번짐)
//   → 수중 효과(화면 가장자리 물결 왜곡 + 약한 비네팅)
//   → OutputPass(ACES 톤매핑 + sRGB 출력 변환)
// =====================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---- 조절용 상수 ----
export const BLOOM_STRENGTH = 0.55;   // 번짐 세기
export const BLOOM_RADIUS = 0.5;      // 번짐 반경
export const BLOOM_THRESHOLD = 1.0;   // 이 밝기(선형 HDR)보다 밝은 곳만 번짐 → 수면·모래는 제외, 발광체만
export const VIGNETTE = 0.32;         // 가장자리 어둡기 (0~1)
export const EDGE_DISTORT = 0.0035;   // 가장자리 물결 왜곡 크기 (화면 비율)

/**
 * 블룸 전에 비정상 픽셀(NaN·무한대)을 걸러낸다.
 * 셰이더 하나가 픽셀 하나라도 NaN을 내면 블룸이 여러 단계로 번지며
 * 화면에 큰 검은 사각형 덩어리가 생기므로, 0으로 바꾸고 너무 밝은 값은 잘라 둔다.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(min(max(c.rgb, vec3(0.0)), vec3(64.0)), 1.0);
    }`,
};

const UnderwaterShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uDistort: { value: EDGE_DISTORT },
    uVignette: { value: VIGNETTE },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uDistort; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float d = length(c);
      // 화면 중앙은 그대로, 가장자리로 갈수록 물결처럼 일렁임
      float edge = smoothstep(0.22, 0.72, d);
      vec2 off = vec2(sin(vUv.y * 23.0 + uTime * 1.7) + 0.5 * sin(vUv.y * 41.0 - uTime * 2.3),
                      cos(vUv.x * 19.0 + uTime * 1.4) + 0.5 * cos(vUv.x * 37.0 + uTime * 2.1)) * uDistort * edge;
      vec4 col = texture2D(tDiffuse, vUv + off);
      // 약한 비네팅
      col.rgb *= mix(1.0 - uVignette, 1.0, smoothstep(0.82, 0.32, d));
      gl_FragColor = col;
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // HDR(HalfFloat) + MSAA 4x 렌더 타깃: 블룸이 밝은 값을 그대로 받고, 계단 현상도 줄임
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new ShaderPass(SanitizeShader)); // NaN 검은 덩어리 방지
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.composer.addPass(this.bloom);
    this.underwater = new ShaderPass(UnderwaterShader);
    this.composer.addPass(this.underwater);
    this.composer.addPass(new OutputPass()); // renderer.toneMapping / outputColorSpace 를 여기서 적용
  }

  setSize(w, h) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  render(dt) {
    this.underwater.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }
}
