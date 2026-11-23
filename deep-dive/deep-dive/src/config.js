// =====================================================================
// 게임 전역 설정값 — 밸런스 조정은 여기서 한 번에
// =====================================================================
export const CONFIG = {
  seed: 1122, // 지형 시드 (같은 값이면 같은 바다)

  world: {
    size: 640,   // 지형 한 변 길이 (m)
    limit: 285,  // 잠수함이 갈 수 있는 최대 |x|, |z|
  },

  terrain: { segments: 200 },

  // 잠수함 물리 (직접 구현한 간단한 수식들)
  sub: {
    thrust: 9.0,          // 전진 추력 가속도 (m/s²)
    reverseFactor: 0.5,   // 후진은 추력의 절반
    yawAccel: 1.9,        // 좌우 회전 각가속도 (rad/s²)
    yawDrag: 2.6,         // 회전 감쇠
    ballastRate: 0.55,    // 밸러스트 탱크가 목표치로 바뀌는 속도 (/s) → 천천히 가속되는 느낌
    buoyAccel: 6.0,       // 밸러스트 최대일 때 상하 가속도
    forwardDrag: 0.45,    // 전후 방향 선형 저항
    lateralDrag: 1.6,     // 옆 방향 저항 (용골 효과: 옆으로 잘 안 미끄러짐)
    verticalDrag: 0.85,   // 상하 방향 저항
    quadDrag: 0.02,       // 속도² 에 비례하는 저항
    lowPowerFactor: 0.4,  // 배터리 방전 시 추력 배율 (최고 속도 약 절반)
    maxSurfaceY: -0.8,    // 수면 위로는 못 올라감
    hitRadius: 1.5,       // 충돌 구 반지름 (앞·중앙·뒤 3개)
    hitOffset: 2.6,       // 앞/뒤 충돌 구 위치
  },

  survival: {
    oxygenTime: 210,       // 산소 가득일 때 버티는 시간(초)
    batteryIdle: 0.05,     // 초당 배터리 소모량들 (%)
    batteryThrust: 0.32,
    batteryVertical: 0.12,
    batteryLight: 0.25,
    warnDepth: 90,         // 압력 경고 시작 수심
    safeDepth: 100,        // 이보다 깊으면 선체 손상
    pressureDamage: 1.5,   // 초당 기본 압력 피해
    refillOxygen: 30,      // 기지 도킹 시 초당 회복량
    refillBattery: 25,
    repairHull: 6,
  },

  base: { radius: 15, maxDepth: 14 }, // 기지 도킹 판정 (수평 반경, 최대 수심)

  treasureCount: 10,
  collectRadius: 4.5,

  sonar: { cooldown: 5, range: 170, waveTime: 1.8, revealTime: 6 },

  fish: { schools: 5, perSchool: 36 }, // 5무리 × 36 = 180마리
  sharkCount: 2,

  // 에셋 경로 — 없으면 절차적 대체 모델/텍스처로 자동 전환
  assets: {
    submarine: ['assets/models/submarine.glb'],
    // 브라우저는 폴더 목록을 읽을 수 없으므로 시도할 파일명을 나열
    fish: [
      'assets/models/fish/fish.glb',
      'assets/models/fish/fish1.glb',
      'assets/models/fish/fish2.glb',
      'assets/models/fish/fish3.glb',
    ],
    shark: ['assets/models/shark.glb', 'assets/models/fish/shark.glb'],
    treasure: ['assets/models/treasure.glb'],
    shipwreck: ['assets/models/shipwreck.glb'],
    causticsFrames: 32,
    causticsFrame: (i) => `assets/textures/caustics/caust${String(i).padStart(2, '0')}.png`,
    sand: {
      diffuse: ['assets/textures/sand/diffuse.jpg', 'assets/textures/sand/diffuse.png'],
      normal: ['assets/textures/sand/normal.jpg', 'assets/textures/sand/normal.png'],
      roughness: ['assets/textures/sand/roughness.jpg', 'assets/textures/sand/roughness.png'],
    },
  },
};
