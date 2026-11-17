// 遊戲規則數值。模擬以每秒 10 個 tick 進行，時間單位都是 tick。
export const W = 50;
export const H = 50;
export const N = W * H;
export const TPS = 10;
export const MATCH_TICKS = 5 * 60 * TPS;

export const T = { DIRT: 0, HARD: 1, ROCK: 2, FLOOR: 3 };
export const UNKNOWN = 255;

export const C = {
  // 經濟
  startMoney: 60,
  homeIncome: 1, // 每秒
  mineIncome: 1, // 一般礦井，每秒
  neutralIncome: 2, // 中立礦井，每秒
  dirtMoney: 2,
  oreMoney: 15,
  treasureMoney: 80, // 搶到大寶藏的錢（另外還會多一個假的家）
  // 礦工動作時間
  moveTicks: 3,
  digTicks: 8,
  hardMul: 3,
  mudMul: 3,
  torchTicks: 4,
  useTicks: 8,
  teleportTicks: 5,
  captureTicks: 30,
  treasureTicks: 80,
  respawnTicks: 120,
  // 視野
  minerVision: 2,
  homeVision: 5,
  // 礦工
  startMiners: 3,
  maxMiners: 5,
  maxQueue: 8, // 每名礦工最多可以排幾個後續任務
  sellBase: 40,
  upgradeCost: [60, 120],
  digMul: [1, 0.75, 0.55],
  moveMul: [1, 0.9, 0.8],
  hp: [3, 4, 5],
  attackCd: 6,
  bombSlow: 1.6, // 拿著炸彈時，移動與挖掘時間的倍率
  // 道具
  laserRange: 3,
  laserCd: 60,
  laserAvoid: 150, // 找路時，走進已曝光敵方激光塔射程的額外代價
  freezeTicks: 50,
  spellRange: 4,
  snuffRange: 4,
  // 公告（中立礦井的位置開局就公開，不用等公告）
  announceVisionTick: 4 * 60 * TPS,
};

export const idx = (x, y) => y * W + x;
export const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
