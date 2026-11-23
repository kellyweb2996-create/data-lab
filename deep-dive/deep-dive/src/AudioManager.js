// =====================================================================
// AudioManager — Web Audio API로 모든 소리를 실시간 합성 (파일 불필요)
//   · 엔진 험: 톱니파+삼각파 → 로우패스, 속도에 따라 피치/밝기 변화
//   · 수중 앰비언스: 브라운 노이즈
//   · 소나 핑 + 표적 반향, 거품, 충돌음, 수집음, 경보음
// =====================================================================
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  /** 브라우저 정책상 사용자 입력(클릭) 후에 호출해야 함 */
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();

    // 마스터 체인: 물속처럼 먹먹하게 고역을 살짝 깎음
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass'; muffle.frequency.value = 4200;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(muffle).connect(comp).connect(ctx.destination);

    // 공용 노이즈 버퍼
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // ---- 엔진 험 ----
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass'; this.engineFilter.frequency.value = 160; this.engineFilter.Q.value = 3;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth'; this.osc1.frequency.value = 38;
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'triangle'; this.osc2.frequency.value = 76.5;
    // 프로펠러 "웅웅"거림을 위한 진폭 LFO
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 4;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.25;
    const engineAmp = ctx.createGain(); engineAmp.gain.value = 0.75;
    this.lfo.connect(lfoGain).connect(engineAmp.gain);
    this.osc1.connect(this.engineFilter); this.osc2.connect(this.engineFilter);
    this.engineFilter.connect(engineAmp).connect(this.engineGain).connect(this.master);
    this.osc1.start(); this.osc2.start(); this.lfo.start();

    // ---- 수중 앰비언스 (브라운 노이즈) ----
    const brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    const amb = ctx.createBufferSource(); amb.buffer = brown; amb.loop = true;
    const ambF = ctx.createBiquadFilter(); ambF.type = 'lowpass'; ambF.frequency.value = 420;
    this.ambGain = ctx.createGain(); this.ambGain.gain.value = 0.0;
    amb.connect(ambF).connect(this.ambGain).connect(this.master);
    amb.start();

    // ---- 소나 에코용 딜레이 ----
    this.echo = ctx.createDelay(1.0); this.echo.delayTime.value = 0.32;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const echoF = ctx.createBiquadFilter(); echoF.type = 'lowpass'; echoF.frequency.value = 2200;
    this.echo.connect(echoF).connect(fb).connect(this.echo);
    echoF.connect(this.master);
  }

  get ready() { return !!this.ctx; }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  /** 엔진: 속도에 따라 피치·필터·음량 변화 */
  setEngine(speed, thrust, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, speed / 13);
    const f = 36 + s * 34 + Math.abs(thrust) * 6;
    this.osc1.frequency.setTargetAtTime(f, t, 0.15);
    this.osc2.frequency.setTargetAtTime(f * 2.02, t, 0.15);
    this.lfo.frequency.setTargetAtTime(3 + s * 9, t, 0.2);
    this.engineFilter.frequency.setTargetAtTime(140 + s * 380 + Math.abs(thrust) * 60, t, 0.15);
    this.engineGain.gain.setTargetAtTime(active ? 0.05 + s * 0.13 + Math.abs(thrust) * 0.03 : 0, t, 0.2);
    this.ambGain.gain.setTargetAtTime(active ? 0.22 : 0.08, t, 0.5);
  }

  /** 소나 핑 + 탐지된 표적마다 거리에 비례한 반향 */
  ping(found = []) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const blip = (when, freq, vol, dur) => {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(freq, when);
      o.frequency.exponentialRampToValueAtTime(freq * 0.94, when + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(vol, when + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      o.connect(g); g.connect(this.master); g.connect(this.echo);
      o.start(when); o.stop(when + dur + 0.05);
    };
    blip(t, 1480, 0.35, 1.6);
    for (const f of found.slice(0, 6)) {
      const delay = 0.4 + (f.dist / 170) * 1.6;
      blip(t + delay, f.type === 'shark' ? 900 : 1760, 0.08, 0.5);
    }
  }

  /** 짧은 거품 소리: 사인파 주파수를 빠르게 올림 */
  bubble(vol = 0.05) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    const f0 = 350 + Math.random() * 600;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * (2 + Math.random()), t + 0.05 + Math.random() * 0.04);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.12);
  }

  /** 충돌음: 저음 쿵 + 금속성 노이즈 */
  collide(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const v = Math.min(1, 0.3 + strength * 0.15);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.4);
    const og = ctx.createGain();
    og.gain.setValueAtTime(v * 0.9, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(og).connect(this.master);
    o.start(t); o.stop(t + 0.55);

    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 700; nf.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(v * 0.6, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    n.connect(nf).connect(ng).connect(this.master);
    n.start(t); n.stop(t + 0.4);
    for (let i = 0; i < 4; i++) setTimeout(() => this.bubble(0.04), i * 40);
  }

  /** 보물 수집: 상승 아르페지오 */
  collect() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = ctx.createGain();
      const w = t + i * 0.09;
      g.gain.setValueAtTime(0.0001, w);
      g.gain.exponentialRampToValueAtTime(0.2, w + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, w + 0.5);
      o.connect(g); g.connect(this.master); g.connect(this.echo);
      o.start(w); o.stop(w + 0.55);
    });
  }

  /** 경보음 (압력/산소 경고) */
  alarm() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 880;
      const g = ctx.createGain();
      const w = t + i * 0.18;
      g.gain.setValueAtTime(0.0001, w);
      g.gain.exponentialRampToValueAtTime(0.06, w + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, w + 0.12);
      o.connect(g).connect(this.master);
      o.start(w); o.stop(w + 0.15);
    }
  }

  /** 상어 공격: 거친 저음 */
  bite() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.35);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(f).connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.45);
    this.collide(3);
  }
}
