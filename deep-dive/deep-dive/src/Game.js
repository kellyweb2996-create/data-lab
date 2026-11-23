// =====================================================================
// Game — 전체 흐름 관리
//   시작 화면 → 잠수 → 탐험 → 성공/실패 결과 화면
//   입력, 카메라, 충돌, 생존 시스템, 기록 저장을 담당
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, damp, loadFirstGLB, loadAllGLB, loadFirstTexture, loadTexture } from './utils.js';
import { Ocean } from './Ocean.js';
import { Terrain } from './Terrain.js';
import { Submarine } from './Submarine.js';
import { TreasureField } from './Treasures.js';
import { FishSchool } from './FishSchool.js';
import { Shark } from './Shark.js';
import { Sonar } from './Sonar.js';
import { HUD } from './HUD.js';
import { AudioManager } from './AudioManager.js';

const BEST_KEY = 'deepDive.best';
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** 에셋을 모두 시도해서 불러오고, 없는 것은 null로 둔다 */
async function loadAssets(onProgress) {
  const A = CONFIG.assets;
  const jobs = {
    submarine: loadFirstGLB(A.submarine),
    fish: loadAllGLB(A.fish),
    shark: loadFirstGLB(A.shark),
    treasure: loadFirstGLB(A.treasure),
    shipwreck: loadFirstGLB(A.shipwreck),
    sandD: loadFirstTexture(A.sand.diffuse),
    sandN: loadFirstTexture(A.sand.normal),
    sandR: loadFirstTexture(A.sand.roughness),
    caust0: loadTexture(A.causticsFrame(0)),
  };
  const keys = Object.keys(jobs);
  let done = 0;
  const results = {};
  await Promise.all(keys.map(async (k) => {
    results[k] = await jobs[k];
    onProgress(++done / keys.length);
  }));

  // 첫 프레임이 있을 때만 나머지 31장을 불러옴
  let caustics = null;
  if (results.caust0) {
    const rest = await Promise.all(Array.from({ length: A.causticsFrames - 1 }, (_, i) => loadTexture(A.causticsFrame(i + 1))));
    caustics = [results.caust0, ...rest].filter(Boolean);
    for (const t of caustics) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  }
  return {
    submarine: results.submarine, fish: results.fish, shark: results.shark,
    treasure: results.treasure, shipwreck: results.shipwreck,
    sand: { diffuse: results.sandD, normal: results.sandN, roughness: results.sandR },
    caustics,
    report: {
      submarine: !!results.submarine, fish: results.fish.length, shark: !!results.shark,
      treasure: !!results.treasure, shipwreck: !!results.shipwreck,
      sand: !!(results.sandD || results.sandN || results.sandR), caustics: caustics ? caustics.length : 0,
    },
  };
}

export class Game {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 900);
    this.clock = new THREE.Clock();
    this.hud = new HUD();
    this.audio = new AudioManager();

    this.state = 'loading';  // loading | menu | playing | paused | over
    this.keys = new Set();
    this.firstPerson = false;
    this.camYaw = 0;         // 마우스로 돌린 시점 오프셋
    this.camPitch = 0.28;
    this.camDist = 14;
    this.camTarget = new THREE.Vector3();
    this.dragging = false;
    this.shake = 0;
    this.time = 0;
    this.bubbleAcc = 0;
  }

  async init() {
    this.hud.setLoading('에셋 불러오는 중… 0%');
    const assets = await loadAssets((p) => this.hud.setLoading(`에셋 불러오는 중… ${Math.round(p * 100)}%`));
    this.assetReport = assets.report;
    console.info('[DeepDive] 에셋 로드 결과 (false/0 = 대체 모델 사용):', assets.report);

    this.ocean = new Ocean(this.scene, assets);
    this.ocean.setPixelRatio(this.pixelRatio);
    this.terrain = new Terrain(this.scene, this.ocean, assets);
    this.sub = new Submarine(this.scene, assets.submarine);
    this.treasures = new TreasureField(this.scene, assets.treasure, this.ocean, this.terrain);
    this.fish = new FishSchool(this.scene, assets.fish, this.terrain);
    const sharkCenters = [new THREE.Vector3(-125, 0, 95), new THREE.Vector3(135, 0, -70)];
    this.sharks = sharkCenters.slice(0, CONFIG.sharkCount).map((c, i) => new Shark(this.scene, assets.shark, this.terrain, c, i));
    this.sonar = new Sonar(this.scene);

    this._bindInput();
    this.resetWorld();
    this._updateCamera(0, true);
    this.state = 'menu';
    this.hud.setLoading('준비 완료', true);
    this.hud.showStart(this._loadBest());
    this.renderer.setAnimationLoop(() => this._loop());
  }

  // ------------------------------------------------------------------
  // 입력
  // ------------------------------------------------------------------
  _bindInput() {
    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (e.repeat) return;
      if (this.state === 'playing') {
        if (e.code === 'KeyQ') this._fireSonar();
        if (e.code === 'KeyL') this._toggleLight();
        if (e.code === 'KeyV') this._toggleView();
      }
      if (e.code === 'KeyM') { this.audio.setMuted(!this.audio.muted); this.hud.toast(this.audio.muted ? '소리 끔' : '소리 켬', 1.2); }
      if (e.code === 'Escape' || e.code === 'KeyP') this._togglePause();
      if (e.code === 'Enter' && (this.state === 'menu' || this.state === 'over')) this.start();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // 마우스 드래그로 시점 회전, 휠로 거리 조절
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this.dragging = true; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', (e) => { this.dragging = false; el.releasePointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.camYaw -= e.movementX * 0.005;
      this.camPitch = clamp(this.camPitch + e.movementY * 0.004, this.firstPerson ? -1.0 : -0.35, this.firstPerson ? 1.0 : 1.25);
      this.lastDrag = this.time;
    });
    el.addEventListener('wheel', (e) => { this.camDist = clamp(this.camDist + e.deltaY * 0.01, 7, 32); }, { passive: true });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    document.getElementById('startBtn').addEventListener('click', () => this.start());
    document.getElementById('retryBtn').addEventListener('click', () => this.start());
    document.getElementById('menuBtn').addEventListener('click', () => {
      this.state = 'menu';
      this.resetWorld();
      this.hud.showStart(this._loadBest());
    });
    document.getElementById('resumeBtn').addEventListener('click', () => this._togglePause());
  }

  _input() {
    const k = this.keys;
    const has = (...c) => c.some((x) => k.has(x));
    return {
      thrust: (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0),
      turn: (has('KeyA', 'ArrowLeft') ? 1 : 0) - (has('KeyD', 'ArrowRight') ? 1 : 0),
      vertical: (has('Space') ? 1 : 0) - (has('ShiftLeft', 'ShiftRight') ? 1 : 0),
    };
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ------------------------------------------------------------------
  // 게임 흐름
  // ------------------------------------------------------------------
  start() {
    if (this.state === 'loading') return;
    this.audio.init();
    this.resetWorld();
    this.state = 'playing';
    this.hud.showPlaying();
    this.hud.toast('잠수 시작! 보물 10개를 찾아 기지로 돌아오세요', 3.5);
    this._updateCamera(0, true);
  }

  resetWorld() {
    this.sub.reset(new THREE.Vector3(0, -5, 26), 0);
    this.oxygen = 100; this.battery = 100; this.hull = 100;
    this.elapsed = 0; this.maxDepth = 0;
    this.docked = false; this.alarmTimer = 0; this.damageCooldown = 0;
    this.camYaw = 0; this.camPitch = 0.28;
    this.firstPerson = false;
    this.sub.model.visible = true;
    this.hud.setFirstPerson(false);
    this.treasures.spawn();
    this.sharks.forEach((s) => s.reset());
    this.sonar.reset();
    this.allFoundNotified = false;
  }

  _togglePause() {
    if (this.state === 'playing') { this.state = 'paused'; this.hud.showPause(true); this.audio.setEngine(0, 0, false); }
    else if (this.state === 'paused') { this.state = 'playing'; this.hud.showPause(false); this.clock.getDelta(); }
  }

  _endGame(success, reason) {
    this.state = 'over';
    this.audio.setEngine(0, 0, false);
    const rec = { treasures: this.treasures.collectedCount, time: this.elapsed, maxDepth: this.maxDepth, success };
    const best = this._loadBest();
    let newRecord = false;
    let next = best ? { ...best } : null;
    const better = !best
      || (rec.success && !best.success)
      || (rec.success === best.success && rec.treasures > best.treasures)
      || (rec.success === best.success && rec.treasures === best.treasures && rec.success && rec.time < best.time);
    if (better) {
      next = { treasures: rec.treasures, time: rec.time, success: rec.success, deepest: best?.deepest ?? 0 };
      newRecord = true;
    }
    if (rec.maxDepth > (next.deepest ?? 0)) next.deepest = rec.maxDepth;
    this._saveBest(next);
    this.hud.showResult({ ...rec, reason, newRecord, best: next });
  }

  _loadBest() {
    try { return JSON.parse(localStorage.getItem(BEST_KEY)); } catch { return null; }
  }
  _saveBest(b) {
    try { localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch { /* 저장 불가 환경 무시 */ }
  }

  // ------------------------------------------------------------------
  // 액션
  // ------------------------------------------------------------------
  _fireSonar() {
    const targets = [
      ...this.treasures.remaining.map((t) => ({ position: t.position, type: 'treasure' })),
      ...this.sharks.map((s) => ({ position: s.position, type: 'shark' })),
    ];
    const found = this.sonar.fire(this.sub.position, targets);
    if (!found) { this.hud.toast(`소나 충전 중… ${this.sonar.cooldown.toFixed(1)}초`, 1); return; }
    this.audio.ping(found);
    const nT = found.filter((f) => f.type === 'treasure').length;
    const nS = found.filter((f) => f.type === 'shark').length;
    this.hud.toast(`소나: 보물 ${nT}개${nS ? `, 상어 ${nS}마리` : ''} 탐지`, 2.5);
  }

  _toggleLight() {
    if (!this.sub.lightOn && this.battery <= 0) { this.hud.toast('배터리가 없어 탐조등을 켤 수 없습니다', 2); return; }
    this.sub.setLight(!this.sub.lightOn);
  }

  _toggleView() {
    this.firstPerson = !this.firstPerson;
    this.sub.model.visible = !this.firstPerson;
    this.hud.setFirstPerson(this.firstPerson);
    this.camYaw = 0;
    this.camPitch = this.firstPerson ? 0 : 0.28;
    this._updateCamera(0, true);
  }

  _damage(amount, shakeAmt = 0.6) {
    if (amount <= 0) return;
    this.hull = Math.max(0, this.hull - amount);
    this.shake = Math.max(this.shake, shakeAmt);
    this.hud.damageFlash();
  }

  // ------------------------------------------------------------------
  // 메인 루프
  // ------------------------------------------------------------------
  _loop() {
    const dt = Math.min(this.clock.getDelta(), 0.05); // 프레임 드랍 시 물리 폭주 방지
    if (this.state === 'paused') { this.renderer.render(this.scene, this.camera); return; }
    this.time += dt;

    if (this.state === 'playing') {
      this._updatePlaying(dt);
    } else {
      // 메뉴/결과 화면: 잠수함은 제자리에서 출렁이고 카메라가 주위를 돎
      this.sub.update(dt, { thrust: 0, turn: 0, vertical: 0 }, 1, this.time);
      for (const s of this.sharks) s.update(dt, this.sub, true);
      this.sonar.update(dt);
      this._updateMenuCamera(dt);
    }

    this.fish.update(dt, this.sub.position);
    this.terrain.update(dt);
    this.treasures.update(dt, this.state === 'playing' ? this.sub.position : _v1.set(1e5, 0, 0), this.time);
    this.ocean.update(dt, this.camera, this.sub.lightOn);
    this.renderer.render(this.scene, this.camera);
  }

  _updatePlaying(dt) {
    const input = this._input();
    const S = CONFIG.survival;
    this.elapsed += dt;

    // ---- 잠수함 물리 ----
    const power = this.battery > 0 ? 1 : CONFIG.sub.lowPowerFactor;
    this.sub.update(dt, input, power, this.time);
    this._resolveCollisions(dt);

    // ---- 거품: 프로펠러 + 밸러스트 배수 ----
    const speed = this.sub.velocity.length();
    this.bubbleAcc += (Math.abs(input.thrust) * 28 * power + speed * 1.5 + Math.abs(input.vertical) * 22) * dt;
    const n = Math.floor(this.bubbleAcc);
    if (n > 0) {
      this.bubbleAcc -= n;
      const prop = this.sub.getPropellerWorld(_v1);
      const back = this.sub.getForward(_v2).multiplyScalar(-2 * Math.abs(input.thrust));
      this.ocean.emitBubbles(prop, n, 0.5, back);
      if (Math.random() < 0.25 + Math.abs(input.vertical) * 0.3) this.audio.bubble(0.03 + Math.random() * 0.03);
    }

    // ---- 보물 수집 ----
    for (const t of this.treasures.update(0, this.sub.position, this.time)) {
      this.audio.collect();
      this.ocean.emitBubbles(t.position, 30, 2.5);
      const c = this.treasures.collectedCount;
      this.hud.toast(c === CONFIG.treasureCount ? '모든 보물을 찾았습니다! 수면 기지로 귀환하세요!' : `보물 획득! (${c} / ${CONFIG.treasureCount})`, 3);
    }

    // ---- 상어 ----
    const nearBase = Math.hypot(this.sub.position.x, this.sub.position.z) < 40 && this.sub.position.y > -25;
    for (const s of this.sharks) {
      if (s.update(dt, this.sub, nearBase) === 'bite') {
        this._damage(15, 1.2);
        this.audio.bite();
        _v1.subVectors(this.sub.position, s.position).normalize();
        this.sub.velocity.addScaledVector(_v1, 10);
        this.ocean.emitBubbles(this.sub.position, 40, 3);
        this.hud.toast('상어의 공격! 선체 손상', 2);
      }
    }

    // ---- 생존 시스템 ----
    const depth = Math.max(0, -this.sub.position.y);
    this.maxDepth = Math.max(this.maxDepth, depth);
    const docked = this.ocean.isAtBase(this.sub.position);
    if (docked && !this.docked) this.hud.toast('기지 도킹 — 산소·배터리 충전 및 선체 수리 중', 3);
    this.docked = docked;

    if (docked) {
      this.oxygen = Math.min(100, this.oxygen + S.refillOxygen * dt);
      this.battery = Math.min(100, this.battery + S.refillBattery * dt);
      this.hull = Math.min(100, this.hull + S.repairHull * dt);
    } else {
      this.oxygen -= (100 / S.oxygenTime) * (1 + depth / 250) * dt; // 깊을수록 조금 더 빨리 소모
      const drain = S.batteryIdle + S.batteryThrust * Math.abs(input.thrust) + S.batteryVertical * Math.abs(input.vertical) + (this.sub.lightOn ? S.batteryLight : 0);
      const wasCharged = this.battery > 0;
      this.battery = Math.max(0, this.battery - drain * dt);
      if (wasCharged && this.battery <= 0) {
        this.sub.setLight(false);
        this.hud.toast('배터리 방전! 속도가 절반으로 떨어집니다', 3);
      }
    }

    // 수심 제한: 안전 수심을 넘으면 압력으로 서서히 손상
    this.alarmTimer -= dt;
    if (depth > S.safeDepth) {
      this.hull -= (S.pressureDamage + (depth - S.safeDepth) * 0.15) * dt;
      this.shake = Math.max(this.shake, 0.08);
    }
    const danger = depth > S.safeDepth || this.oxygen < 20 || this.hull < 25;
    if (danger && this.alarmTimer <= 0) { this.audio.alarm(); this.alarmTimer = 1.6; }

    // ---- 소나 ----
    this.sonar.update(dt);

    // ---- 카메라 & HUD & 소리 ----
    this.sub.beam.visible = this.sub.lightOn && !this.firstPerson;
    this._updateCamera(dt, false, input);
    this.audio.setEngine(speed, input.thrust * power, true);
    this.hud.update(dt, {
      depth, maxDepth: this.maxDepth, oxygen: this.oxygen, battery: this.battery, hull: this.hull,
      treasures: this.treasures.collectedCount, time: this.elapsed,
      lightOn: this.sub.lightOn, firstPerson: this.firstPerson, docked,
      sonarCooldown: this.sonar.cooldown, sonarWave: this.sonar.waveT,
      heading: this.sub.heading, subPos: this.sub.position, basePos: this.ocean.basePosition,
      marks: this.sonar.marks, now: this.sonar.time,
    });

    // ---- 승패 판정 ----
    if (this.hull <= 0) return this._endGame(false, '선체가 파손되었습니다.');
    if (this.oxygen <= 0) return this._endGame(false, '산소가 바닥났습니다.');
    if (docked && this.treasures.collectedCount >= CONFIG.treasureCount) {
      return this._endGame(true, '모든 보물을 싣고 무사히 기지로 귀환했습니다!');
    }
  }

  /** 지형/바위와의 충돌: 밀어내고 법선 방향으로 튕김, 충격량에 비례해 손상 */
  _resolveCollisions(dt) {
    const sub = this.sub, v = sub.velocity;
    const { hitRadius: r, hitOffset } = CONFIG.sub;
    const fwd = sub.getForward(_v2);
    let impact = 0;
    const bounce = (n) => {
      const vn = v.dot(n);
      if (vn < 0) {
        v.addScaledVector(n, -1.5 * vn); // 반발 계수 0.5
        v.multiplyScalar(0.9);
        impact = Math.max(impact, -vn);
      }
    };
    for (const k of [0, hitOffset, -hitOffset]) {
      const p = _v1.copy(sub.position).addScaledVector(fwd, k);
      // 해저 지형
      const floor = this.terrain.heightAt(p.x, p.z);
      const pen = floor + r - p.y;
      if (pen > 0) {
        sub.position.y += pen;
        p.y += pen;
        bounce(this.terrain.normalAt(p.x, p.z, _n));
      }
      // 바위·난파선 (충돌 구)
      for (const o of this.terrain.obstacles) {
        const dx = p.x - o.pos.x, dy = p.y - o.pos.y, dz = p.z - o.pos.z;
        const minD = r + o.r;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= minD * minD) continue;
        const d = Math.sqrt(d2) || 1e-3;
        _n.set(dx / d, dy / d, dz / d);
        sub.position.addScaledVector(_n, minD - d);
        p.addScaledVector(_n, minD - d);
        bounce(_n);
      }
    }
    // 세계 경계
    const L = CONFIG.world.limit;
    for (const axis of ['x', 'z']) {
      if (Math.abs(sub.position[axis]) > L) {
        sub.position[axis] = Math.sign(sub.position[axis]) * L;
        v[axis] *= -0.4;
      }
    }

    this.damageCooldown -= dt;
    if (impact > 1.2) {
      if (this.damageCooldown <= 0) {
        this._damage((impact - 1.2) * 2.4, Math.min(1, impact * 0.12));
        this.audio.collide(impact);
        this.ocean.emitBubbles(sub.position, 12 + Math.floor(impact * 3), 3);
        this.damageCooldown = 0.35;
      }
    }
  }

  // ------------------------------------------------------------------
  // 카메라
  // ------------------------------------------------------------------
  _updateCamera(dt, instant = false, input = null) {
    const cam = this.camera, sub = this.sub;
    if (this.firstPerson) {
      // 조종석: 선체 기울기를 그대로 따르고 마우스로 둘러보기
      sub.tiltGroup.updateWorldMatrix(true, false);
      sub.tiltGroup.localToWorld(cam.position.set(0, 0.55, 2.7));
      sub.tiltGroup.getWorldQuaternion(_q);
      _e.set(this.camPitch, Math.PI + this.camYaw, 0, 'YXZ');
      cam.quaternion.copy(_q).multiply(new THREE.Quaternion().setFromEuler(_e));
    } else {
      // 3인칭: 뒤쪽 위에서 lerp로 부드럽게 따라감
      if (input && input.thrust !== 0 && !this.dragging && this.time - (this.lastDrag || 0) > 1.5) {
        this.camYaw += (0 - this.camYaw) * damp(0.8, dt); // 이동 중엔 서서히 뒤로 복귀
      }
      const a = sub.heading + this.camYaw;
      const target = _v1.copy(sub.position).add(_v2.set(0, 1.2, 0));
      const cp = Math.cos(this.camPitch), spch = Math.sin(this.camPitch);
      const desired = _v2.set(
        target.x - Math.sin(a) * this.camDist * cp,
        target.y + this.camDist * spch,
        target.z - Math.cos(a) * this.camDist * cp,
      );
      desired.y = Math.min(desired.y, -0.6); // 수면 위로 나가지 않게
      desired.y = Math.max(desired.y, this.terrain.heightAt(desired.x, desired.z) + 1.5);
      if (instant) { cam.position.copy(desired); this.camTarget.copy(target); }
      else {
        cam.position.lerp(desired, damp(5, dt));
        this.camTarget.lerp(target, damp(12, dt));
      }
      cam.lookAt(this.camTarget);
    }
    // 충돌 흔들림
    if (this.shake > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shake;
      cam.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-6 * dt);
    }
  }

  _updateMenuCamera(dt) {
    const a = this.time * 0.08;
    const p = this.sub.position;
    this.camera.position.lerp(_v1.set(p.x + Math.sin(a) * 20, -3 - Math.sin(this.time * 0.2) * 2, p.z + Math.cos(a) * 20), damp(2, dt));
    this.camTarget.lerp(_v2.set(p.x, p.y - 2, p.z), damp(2, dt));
    this.camera.lookAt(this.camTarget);
  }
}
