// =====================================================================
// HUD — 계기판, 경고, 원형 소나 레이더, 시작/결과 화면
// =====================================================================
import { CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);

export function formatTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class HUD {
  constructor() {
    this.root = $('hud');
    this.depth = $('depthVal');
    this.maxDepth = $('maxDepthVal');
    this.treasure = $('treasureVal');
    this.timeEl = $('timeVal');
    this.gauges = {
      oxygen: $('g-oxygen'), battery: $('g-battery'), hull: $('g-hull'),
    };
    this.warnings = $('warnings');
    this.toastEl = $('toast');
    this.flash = $('damageFlash');
    this.porthole = $('porthole');
    this.status = { light: $('st-light'), view: $('st-view'), dock: $('st-dock') };
    this.sonarCd = $('sonarCd');
    this.radar = $('radar');
    this.ctx = this.radar.getContext('2d');
    this.sweep = 0;
    this.toastTimer = 0;
    this._lastWarn = '';
  }

  // ---- 화면 전환 ------------------------------------------------------
  setLoading(text, done = false) {
    $('loadingText').textContent = text;
    $('startBtn').disabled = !done;
  }
  showStart(best) {
    $('startScreen').classList.remove('hidden');
    $('resultScreen').classList.add('hidden');
    this.root.classList.add('hidden');
    $('bestStart').innerHTML = best ? this._bestHTML(best) : '아직 기록이 없습니다.';
  }
  showPlaying() {
    $('startScreen').classList.add('hidden');
    $('resultScreen').classList.add('hidden');
    $('pauseScreen').classList.add('hidden');
    this.root.classList.remove('hidden');
  }
  showPause(on) { $('pauseScreen').classList.toggle('hidden', !on); }
  showResult(r) {
    this.root.classList.add('hidden');
    $('resultScreen').classList.remove('hidden');
    $('resultTitle').textContent = r.success ? '임무 성공!' : '임무 실패';
    $('resultTitle').className = r.success ? 'ok' : 'fail';
    $('resultReason').textContent = r.reason;
    $('resTreasure').textContent = `${r.treasures} / ${CONFIG.treasureCount}`;
    $('resTime').textContent = formatTime(r.time);
    $('resDepth').textContent = `${r.maxDepth.toFixed(1)} m`;
    $('resNew').classList.toggle('hidden', !r.newRecord);
    $('bestResult').innerHTML = r.best ? this._bestHTML(r.best) : '-';
  }
  _bestHTML(b) {
    return `최고 기록 · 보물 <b>${b.treasures}</b>개 · 시간 <b>${formatTime(b.time)}</b>` +
      `${b.success ? ' · 성공' : ''}<br>최대 수심 기록 <b>${(b.deepest ?? 0).toFixed(1)} m</b>`;
  }

  toast(text, sec = 2.5) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastTimer = sec;
  }

  damageFlash() {
    this.flash.classList.remove('on');
    void this.flash.offsetWidth; // 애니메이션 재시작
    this.flash.classList.add('on');
  }

  setFirstPerson(on) { this.porthole.classList.toggle('hidden', !on); }

  _gauge(el, value) {
    const v = Math.max(0, Math.min(100, value));
    el.querySelector('i').style.width = `${v}%`;
    el.querySelector('span').textContent = `${Math.ceil(v)}%`;
    el.classList.toggle('low', v < 25);
  }

  /** 매 프레임 갱신 */
  update(dt, s) {
    this.depth.textContent = s.depth.toFixed(1);
    this.maxDepth.textContent = s.maxDepth.toFixed(0);
    this.depth.parentElement.classList.toggle('danger', s.depth > CONFIG.survival.warnDepth);
    this.treasure.textContent = `보물 ${s.treasures} / ${CONFIG.treasureCount}`;
    this.timeEl.textContent = formatTime(s.time);
    this._gauge(this.gauges.oxygen, s.oxygen);
    this._gauge(this.gauges.battery, s.battery);
    this._gauge(this.gauges.hull, s.hull);

    this.status.light.textContent = s.lightOn ? '탐조등 ON' : '탐조등 OFF';
    this.status.light.classList.toggle('on', s.lightOn);
    this.status.view.textContent = s.firstPerson ? '1인칭' : '3인칭';
    this.status.dock.classList.toggle('hidden', !s.docked);

    // 경고 문구
    const w = [];
    if (s.depth > CONFIG.survival.safeDepth) w.push('⚠ 압력 한계 초과 — 선체 손상 중!');
    else if (s.depth > CONFIG.survival.warnDepth) w.push('⚠ 압력 경고: 안전 수심 100m 근접');
    if (s.oxygen < 25) w.push('⚠ 산소 부족 — 기지로 귀환하세요');
    if (s.battery <= 0) w.push('⚠ 배터리 방전 — 출력 저하');
    else if (s.battery < 20) w.push('배터리 부족');
    if (s.hull < 30) w.push('⚠ 선체 내구도 위험');
    const html = w.map((t) => `<div>${t}</div>`).join('');
    if (html !== this._lastWarn) { this.warnings.innerHTML = html; this._lastWarn = html; }

    // 소나 쿨타임
    this.sonarCd.textContent = s.sonarCooldown > 0 ? `소나 ${s.sonarCooldown.toFixed(1)}s` : '소나 준비 (Q)';
    this.sonarCd.classList.toggle('ready', s.sonarCooldown <= 0);

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
    this._drawRadar(dt, s);
  }

  /** 원형 소나 레이더: 진행 방향이 위쪽 */
  _drawRadar(dt, s) {
    const g = this.ctx, W = this.radar.width, R = W / 2 - 6, C = W / 2;
    const range = CONFIG.sonar.range;
    g.clearRect(0, 0, W, W);

    // 배경 + 동심원
    g.fillStyle = 'rgba(2, 24, 32, 0.78)';
    g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(100, 240, 255, 0.25)';
    g.lineWidth = 1;
    for (let k = 1; k <= 3; k++) { g.beginPath(); g.arc(C, C, (R * k) / 3, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(C - R, C); g.lineTo(C + R, C); g.moveTo(C, C - R); g.lineTo(C, C + R); g.stroke();

    // 회전하는 스윕
    this.sweep += dt * 1.6;
    const grd = g.createConicGradient ? g.createConicGradient(this.sweep - 0.6, C, C) : null;
    if (grd) {
      grd.addColorStop(0, 'rgba(100,240,255,0)');
      grd.addColorStop(0.1, 'rgba(100,240,255,0.22)');
      grd.addColorStop(0.1001, 'rgba(100,240,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.fill();
    }

    // 소나 파동 링
    if (s.sonarWave >= 0) {
      const rr = R * (1 - Math.pow(1 - s.sonarWave, 2));
      g.strokeStyle = `rgba(140,250,255,${1 - s.sonarWave})`;
      g.lineWidth = 2;
      g.beginPath(); g.arc(C, C, rr, 0, Math.PI * 2); g.stroke();
    }

    // 월드 좌표 → 레이더 좌표 (잠수함 기준, 진행 방향이 위)
    const sin = Math.sin(s.heading), cos = Math.cos(s.heading);
    const toRadar = (p) => {
      const dx = p.x - s.subPos.x, dz = p.z - s.subPos.z;
      const right = -dx * cos + dz * sin;     // 잠수함 오른쪽 성분
      const fwd = dx * sin + dz * cos;        // 앞쪽 성분
      return [right / range * R, -fwd / range * R];
    };

    // 기지: 항상 표시, 범위 밖이면 가장자리에 고정
    {
      let [x, y] = toRadar(s.basePos);
      const d = Math.hypot(x, y);
      const out = d > R - 8;
      if (out) { x *= (R - 8) / d; y *= (R - 8) / d; }
      g.fillStyle = '#5ff6ff';
      g.fillRect(C + x - 5, C + y - 5, 10, 10);
      g.fillStyle = '#022';
      g.font = 'bold 8px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('B', C + x, C + y + 0.5);
    }

    // 소나에 잡힌 표적
    for (const m of s.marks) {
      if (s.now < m.from) continue;
      const life = (m.until - s.now) / CONFIG.sonar.revealTime;
      const [x, y] = toRadar(m.pos);
      if (Math.hypot(x, y) > R) continue;
      const a = Math.min(1, life * 1.5);
      if (m.type === 'treasure') {
        g.fillStyle = `rgba(255, 210, 70, ${a})`;
        g.beginPath(); g.arc(C + x, C + y, 4.5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = `rgba(255, 210, 70, ${a * 0.5})`;
        g.beginPath(); g.arc(C + x, C + y, 4.5 + (1 - life) * 10, 0, Math.PI * 2); g.stroke();
        // 깊이 차이 표시 (▲ 위 / ▼ 아래)
        const dy = m.pos.y - s.subPos.y;
        if (Math.abs(dy) > 8) {
          g.font = '9px sans-serif';
          g.fillText(dy > 0 ? '▲' : '▼', C + x + 9, C + y);
        }
      } else {
        g.fillStyle = `rgba(255, 80, 80, ${a})`;
        g.beginPath(); g.moveTo(C + x, C + y - 5); g.lineTo(C + x + 4, C + y + 4); g.lineTo(C + x - 4, C + y + 4); g.fill();
      }
    }

    // 잠수함 (중앙 삼각형)
    g.fillStyle = '#ffd25a';
    g.beginPath(); g.moveTo(C, C - 7); g.lineTo(C + 5, C + 5); g.lineTo(C - 5, C + 5); g.closePath(); g.fill();

    g.strokeStyle = 'rgba(100, 240, 255, 0.6)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.stroke();
  }
}
