// =====================================================================
// 공용 유틸: 난수, 심플렉스 노이즈, 에셋 로더, 절차적 텍스처
// =====================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 프레임레이트와 무관한 지수 감쇠 보간 계수 */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** 시드 고정 난수 (mulberry32) */
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------
// 2D 심플렉스 노이즈 (Stefan Gustavson 알고리즘을 간결하게 옮김)
// ---------------------------------------------------------------------
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];

export class SimplexNoise {
  constructor(rand = Math.random) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise2D(xin, yin) {
    const P = this.perm;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = GRAD[P[ii + P[jj]] & 7]; t0 *= t0; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = GRAD[P[ii + i1 + P[jj + j1]] & 7]; t1 *= t1; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = GRAD[P[ii + 1 + P[jj + 1]] & 7]; t2 *= t2; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * n; // 대략 -1 ~ 1
  }

  /** 여러 옥타브를 겹친 프랙탈 노이즈 */
  fbm(x, y, octaves = 4) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise2D(x * freq, y * freq);
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  }
}

// ---------------------------------------------------------------------
// 에셋 로더 — 실패하면 null을 돌려줘서 호출부가 대체 모델을 쓰게 함
// ---------------------------------------------------------------------
const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

export function loadGLB(url) {
  return new Promise((resolve) => {
    gltfLoader.load(url, (g) => resolve(g), undefined, () => resolve(null));
  });
}
export async function loadFirstGLB(urls) {
  for (const u of urls) { const g = await loadGLB(u); if (g) return g; }
  return null;
}
export async function loadAllGLB(urls) {
  return (await Promise.all(urls.map(loadGLB))).filter(Boolean);
}
export function loadTexture(url) {
  return new Promise((resolve) => {
    texLoader.load(url, (t) => resolve(t), undefined, () => resolve(null));
  });
}
export async function loadFirstTexture(urls) {
  for (const u of urls) { const t = await loadTexture(u); if (t) return t; }
  return null;
}

/** 모델을 가장 긴 축이 targetSize가 되도록 스케일하고 중심을 원점으로 */
export function fitModel(object, targetSize) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = targetSize / Math.max(size.x, size.y, size.z, 1e-6);
  const wrapper = new THREE.Group();
  object.position.sub(center);
  wrapper.add(object);
  wrapper.scale.setScalar(s);
  return wrapper;
}

// ---------------------------------------------------------------------
// 절차적 캔버스 텍스처
// ---------------------------------------------------------------------
function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 부드러운 원형 발광 텍스처 (스프라이트용) */
export function makeGlowTexture() {
  return canvasTexture(128, 128, (g, w) => {
    const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
  });
}

/** 빛줄기 텍스처: 위는 밝고 아래로 사라지며 좌우 가장자리가 부드러움 */
export function makeRayTexture() {
  return canvasTexture(64, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const v = Math.pow(1 - y / h, 1.6);
      for (let x = 0; x < w; x++) {
        const u = Math.sin((x / (w - 1)) * Math.PI);
        const a = v * u * u;
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/**
 * caustics 프레임 파일이 없을 때 쓰는 대체 텍스처.
 * 타일링되는 보로노이(F2-F1) 패턴으로 물빛 그물 무늬를 만든다.
 */
export function makeCausticTexture(rand = Math.random) {
  const tex = canvasTexture(256, 256, (g, w, h) => {
    const N = 22;
    const pts = [];
    for (let i = 0; i < N; i++) pts.push([rand() * w, rand() * h]);
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let f1 = 1e9, f2 = 1e9;
        for (const [px, py] of pts) {
          // 9개 복사본 중 가장 가까운 점 (타일링)
          for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
            const dx = x - (px + ox * w), dy = y - (py + oy * h);
            const d = dx * dx + dy * dy;
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
          }
        }
        const e = Math.sqrt(f2) - Math.sqrt(f1);
        const v = Math.pow(clamp(1 - e / 14, 0, 1), 3);
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, false);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
