// =====================================================================
// 진입점: 게임 생성 및 초기화
// =====================================================================
import { Game } from './src/Game.js';

const game = new Game(document.getElementById('app'));
game.init().catch((err) => {
  console.error(err);
  document.getElementById('loadingText').textContent = '초기화 실패: ' + err.message;
});
window.__game = game; // 디버깅용
