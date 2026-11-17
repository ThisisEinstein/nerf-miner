// 像素圖資料。所有圖都是 16×16（家是 48×48）的點陣，用文字或簡單的畫點指令描述，
// 這個檔案不碰瀏覽器，所以也能在測試裡檢查每一張圖的尺寸和用色對不對。
// 之後要換美術：改這裡的圖，或讓 sprites.js 改成載入圖檔。
import { mulberry32 } from '../sim/rng.js';

export const S = 16;
export const INK = '#1a1410';

// 一個字母代表一個顏色；'.' 是透明
export const PAL = {
  k: INK,
  K: '#0b0806',
  d: '#4a2f1b',
  D: '#5f3f26',
  b: '#7a5232',
  B: '#96683f',
  t: '#b8875a',
  s: '#221c19',
  S: '#332a26',
  f: '#4a3e37',
  g: '#3d404b',
  G: '#5a5f6e',
  h: '#868c9e',
  H: '#bcc2d2',
  w: '#ffffff',
  c: '#e2d8c3',
  C: '#b5a88e',
  y: '#ffd24a',
  Y: '#fff3b0',
  v: '#c9912a',
  o: '#f08a1e',
  O: '#c45a12',
  r: '#e23b33',
  R: '#9c2420',
  p: '#a06bf0',
  P: '#5d3a9c',
  n: '#8a5a2c',
  N: '#5a3516',
  m: '#b5834a',
  l: '#62b04c',
  L: '#3f7d31',
  i: '#9fe3ff',
  I: '#3a8fc4',
  q: '#f0c8a0',
  Q: '#c9966e',
  z: '#23252c',
  Z: '#565c69',
  x: '#2a1a12',
  u: '#3d8bff',
  U: '#2456ad',
  e: '#6fe06f',
};

export const TEAM = [
  { main: '#3d8bff', dark: '#2456ad', light: '#a8ccff', glow: '110,165,255' },
  { main: '#ff5548', dark: '#ad3027', light: '#ffb6ae', glow: '255,125,105' },
];
const NEUTRAL = { main: '#9a9a9a', dark: '#6a6a6a', light: '#d0d0d0' };

// 角色帽子的顏色（4 主色、5 暗色、6 亮色）
export const HATS = {
  digger: { 4: '#f2c230', 5: '#c4941a', 6: '#ffe98a' },
  scout: { 4: '#62b04c', 5: '#3f7d31', 6: '#9fe08a' },
  merchant: { 4: '#8d5fd3', 5: '#5d3a9c', 6: '#c2a2ff' },
  guard: { 4: '#bcc2d2', 5: '#868c9e', 6: '#ffffff' },
};

// 隊伍顏色用 1（主色）、2（暗色）、3（亮色）代表
function teamMap(team) {
  const t = team === 0 || team === 1 ? TEAM[team] : NEUTRAL;
  return { 1: t.main, 2: t.dark, 3: t.light };
}

export class Pix {
  constructor(w = S, h = S) {
    this.w = w;
    this.h = h;
    this.d = new Array(w * h).fill(null);
  }

  get(x, y) {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.d[y * this.w + x];
  }

  set(x, y, c) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c;
    return this;
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
    return this;
  }

  line(x0, y0, x1, y1, c) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return this;
  }

  // 把文字畫上去。rows 每一列等長；map 是額外的顏色對照（隊伍色、帽子色）
  ascii(rows, map = null, ox = 0, oy = 0, name = '?') {
    const w = rows[0].length;
    rows.forEach((row, j) => {
      if (row.length !== w) throw new Error(`像素圖「${name}」第 ${j} 列長度是 ${row.length}，應該是 ${w}`);
      for (let i = 0; i < w; i++) {
        const ch = row[i];
        if (ch === '.') continue;
        const c = (map && map[ch]) || PAL[ch];
        if (!c) throw new Error(`像素圖「${name}」第 ${j} 列用了沒定義的顏色「${ch}」`);
        this.set(ox + i, oy + j, c);
      }
    });
    return this;
  }

  // 自動描邊：有顏色的點旁邊（上下左右）的透明點塗成深色
  outline(c = INK) {
    const add = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push(y * this.w + x);
      }
    }
    for (const i of add) this.d[i] = c;
    return this;
  }

  blit(other, ox = 0, oy = 0) {
    for (let y = 0; y < other.h; y++) {
      for (let x = 0; x < other.w; x++) {
        const c = other.get(x, y);
        if (c) this.set(ox + x, oy + y, c);
      }
    }
    return this;
  }

  flip() {
    const p = new Pix(this.w, this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) p.d[y * this.w + (this.w - 1 - x)] = this.d[y * this.w + x];
    return p;
  }
}

// ======================= 礦工 =======================

const BODY = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....qqqqqq.....',
  '.....qxqqxq.....',
  '.....qqqqqq.....',
  '......QQQQ......',
  '....21111112....',
  '....21133112....',
  '....q113311q....',
  '.....222222.....',
];
const LEGS = {
  stand: ['.....zz..zz.....', '.....NN..NN.....', '................'],
  walk0: ['.....zz..NN.....', '.....NN.........', '................'],
  walk1: ['.....NN..zz.....', '.........NN.....', '................'],
};
const HAT = {
  digger: ['................', '......4444......', '.....446644.....', '....44kYYk44....', '....55555555....', '................'],
  scout: ['................', '................', '......4444......', '......cccc......', '...5555555555...', '................'],
  merchant: ['................', '......4444......', '......4444......', '......yyyy......', '....55555555....', '................'],
  guard: ['................', '.......11.......', '.....HHHHHH.....', '....HhhhhhhH....', '....hhhGGhhh....', '.......GG.......'],
};
// 十字鎬：[x, y, 顏色字母]。front 表示畫在身體前面
const PICK = {
  rest: { front: false, px: [[12, 9, 'n'], [13, 8, 'n'], [13, 7, 'n'], [14, 6, 'n'], [12, 5, 'h'], [13, 5, 'H'], [14, 5, 'H'], [15, 6, 'H'], [15, 7, 'h']] },
  up: { front: true, px: [[12, 9, 'q'], [12, 8, 'n'], [12, 7, 'n'], [12, 6, 'n'], [12, 5, 'n'], [12, 4, 'n'], [9, 4, 'h'], [10, 3, 'H'], [11, 3, 'H'], [12, 3, 'H'], [13, 3, 'H'], [14, 4, 'h']] },
  down: { front: true, px: [[12, 10, 'q'], [13, 10, 'n'], [14, 10, 'n'], [14, 8, 'h'], [15, 9, 'H'], [15, 10, 'H'], [15, 11, 'H'], [14, 12, 'h']] },
};

// pose: 'idle' | 'walk' | 'dig'；frame: 0 或 1
export function minerPix(team, char, pose = 'idle', frame = 0) {
  const map = { ...teamMap(team), ...(HATS[char] || HATS.digger) };
  const p = new Pix();
  const pick = pose === 'dig' ? (frame ? PICK.down : PICK.up) : PICK.rest;
  const drawPick = () => {
    for (const [x, y, ch] of pick.px) p.set(x, y, PAL[ch]);
  };
  if (!pick.front) drawPick();
  p.ascii(BODY, map, 0, 0, 'miner body');
  const legs = pose === 'walk' ? (frame ? LEGS.walk1 : LEGS.walk0) : LEGS.stand;
  p.ascii(legs, map, 0, 13, 'miner legs');
  p.ascii(HAT[char] || HAT.digger, map, 0, 0, `hat ${char}`);
  if (pick.front) drawPick();
  return p.outline();
}

// ======================= 地圖上的東西 =======================

const MINE = [
  '................',
  '.mmmmmmmmmmmmmm.',
  '.nnnnnnnnnnnnnn.',
  '.NNNNNNNNNNNNNN.',
  '..mnNKKKKKKmnN..',
  '..mnNKKKKKKmnN..',
  '..mnNKKKKKKmnN..',
  '..mnNKKyyKKmnN..',
  '..mnNKZZZZKmnN..',
  '..mnNKZZZZKmnN..',
  '..mnNKzKKzKmnN..',
  '..mnNhKhhKhmnN..',
  '..mnNhKhhKhmnN..',
  '..mnNSSSSSSmnN..',
  '................',
  '................',
];
const CHEST = [
  '................',
  '................',
  '................',
  '................',
  '...mmmmmmmmmm...',
  '..mmymmmmmmymm..',
  '..mnynnnnnnynn..',
  '..yyyyyyyyyyyy..',
  '..nnynnYYnnynn..',
  '..nnynnYvnnynn..',
  '..nNyNNNNNNyNn..',
  '..NNvNNNNNNvNN..',
  '................',
  '................',
  '................',
  '................',
];
const LASER = [
  '................',
  '......hHHh......',
  '.....hHrrHh.....',
  '.....hrwrrh.....',
  '.....hHrrHh.....',
  '......hGGh......',
  '.......GG.......',
  '......1111......',
  '......GhhG......',
  '......GhhG......',
  '......GhhG......',
  '.....GGhhGG.....',
  '....ZZGGGGZZ....',
  '...ZZZZZZZZZZ...',
  '................',
  '................',
];
const SPIKE = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '...H...H...H....',
  '..hHh.hHh.hHh...',
  '..hHh.hHh.hHh...',
  '.hhHhhhHhhhHhh..',
  '.hhHHhhHHhhHHh..',
  '.ZZZZZZZZZZZZZ..',
  '.zzzzzzzzzzzzz..',
  '................',
  '................',
  '................',
];
const TORCH_STICK = ['......1111......', '.......nN.......', '.......nN.......', '.......nN.......', '.......nN.......', '.......nN.......'];
const FLAME = [
  ['.......o........', '......oyo.......', '.....ooyoo......', '.....oyYyo......', '.....oyYyo......', '......oyo.......'],
  ['........o.......', '.......oo.......', '......oyoo......', '.....oyYyo......', '.....oyYyo......', '......ooo.......'],
  ['................', '......oo........', '.....oyyo.......', '.....oyYyo......', '.....oyYyo......', '......oyo.......'],
];
const SKULL = ['.ccccccc.', 'ccccccccc', 'ccKKcKKcc', 'ccKKcKKcc', 'ccccKcccc', '.ccccccc.', '.cKcKcKc.', '..ccccc..'];
const BOMB_SMALL = ['.....oY..', '....n....', '...ZZ....', '.zzzzzz..', 'zzZZzzzz.', 'zzZwzzzz.', 'zzzzzzzz.', 'zzzzzzzz.', '.zzzzzz..'];
const ZZZ = ['yyyy....', '..y.....', '.y...yyy', 'yyyy..y.', '.....yyy'];

export const minePix = () => new Pix().ascii(MINE, null, 0, 0, 'mine').outline();
export const chestPix = () => new Pix().ascii(CHEST, null, 0, 0, 'chest').outline();
export const laserPix = (team) => new Pix().ascii(LASER, teamMap(team), 0, 0, 'laser').outline();
export const spikePix = () => new Pix().ascii(SPIKE, null, 0, 0, 'spike').outline();
export const skullPix = () => new Pix(9, 8).ascii(SKULL, null, 0, 0, 'skull');
export const bombSmallPix = () => new Pix(9, 9).ascii(BOMB_SMALL, null, 0, 0, 'bomb small');
export const zzzPix = () => new Pix(8, 5).ascii(ZZZ, null, 0, 0, 'zzz');

export function torchPix(team, frame = 0) {
  const p = new Pix().ascii(TORCH_STICK, teamMap(team), 0, 8, 'torch stick').outline();
  return p.ascii(FLAME[frame % 3], null, 0, 2, 'flame');
}

// 傳送門：一圈會轉的紫色光點
export function portalPix(frame = 0) {
  const p = new Pix();
  const cols = [PAL.P, PAL.p, PAL.i, PAL.p, PAL.P, PAL.P];
  for (let y = 2; y <= 13; y++) {
    for (let x = 3; x <= 12; x++) {
      const dx = (x - 7.5) / 5;
      const dy = (y - 7.5) / 6;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      if (d > 0.5) {
        const a = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
        p.set(x, y, cols[Math.floor(a * 12 + frame * 1.5) % cols.length]);
      } else {
        const a = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
        p.set(x, y, Math.floor(a * 6 + d * 8 - frame * 1.5 + 12) % 3 === 0 ? PAL.P : '#1b0b33');
      }
    }
  }
  return p.outline('#2a124f');
}

// 旗子（6×4），frame 讓它飄
export function flagPix(team, frame = 0) {
  const t = team === 0 || team === 1 ? TEAM[team] : NEUTRAL;
  const p = new Pix(7, 6);
  for (let x = 0; x < 6; x++) {
    const off = (x + frame) % 4 < 2 ? 0 : 1;
    for (let y = 0; y < 4; y++) p.set(x, y + off, y === 3 ? t.dark : y === 0 && x < 3 ? t.light : t.main);
  }
  return p;
}

// ======================= 家（48×48） =======================

export function homePix(team) {
  const t = TEAM[team];
  const p = new Pix(48, 48);
  const r = mulberry32(77);
  // 石板地基
  p.rect(1, 1, 46, 46, '#2a221d');
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const x = 2 + gx * 6 - (gy % 2 ? 3 : 0);
      const y = 2 + gy * 6;
      const c = ['#463a31', '#3c3129', '#4d4037', '#40342c'][Math.floor(r() * 4)];
      for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) if (x + i >= 2 && x + i <= 45 && y + j <= 45) p.set(x + i, y + j, c);
      if (x >= 2 && x <= 45) p.set(x, y, '#5a4c41');
    }
  }
  for (let k = 1; k <= 46; k++) {
    p.set(k, 1, t.dark).set(k, 46, t.dark).set(1, k, t.dark).set(46, k, t.dark);
    p.set(k, 0, INK).set(k, 47, INK).set(0, k, INK).set(47, k, INK);
  }
  for (let k = 2; k <= 45; k++) p.set(k, 2, t.main).set(2, k, t.main);
  // 影子
  p.rect(8, 42, 33, 2, '#1c1613');
  // 煙囪
  p.rect(31, 8, 5, 10, PAL.G).rect(31, 8, 1, 10, PAL.h).rect(35, 8, 1, 10, PAL.g).rect(30, 6, 7, 2, PAL.h).rect(30, 7, 7, 1, PAL.g);
  // 木屋牆
  p.rect(10, 22, 28, 19, PAL.m);
  for (let y = 25; y < 41; y += 4) p.rect(10, y, 28, 1, PAL.n);
  p.rect(10, 22, 2, 19, '#c99a5e').rect(36, 22, 2, 19, PAL.n);
  for (let y = 22; y <= 40; y++) p.set(9, y, INK).set(38, y, INK);
  // 石頭底座
  p.rect(8, 41, 32, 3, PAL.h).rect(8, 41, 32, 1, PAL.H).rect(8, 43, 32, 1, PAL.G);
  for (let x = 12; x < 40; x += 5) p.set(x, 42, PAL.g).set(x, 43, PAL.g);
  p.rect(7, 44, 34, 1, INK);
  // 屋頂（三角形）
  for (let y = 7; y <= 22; y++) {
    const half = Math.round((y - 6) * 1.25);
    for (let x = 24 - half; x <= 23 + half; x++) {
      let c = x >= 24 ? t.dark : t.main;
      if ((y - 7) % 3 === 2) c = x >= 24 ? '#00000055' : t.dark;
      if (c === '#00000055') c = shade(t.dark, 0.78);
      p.set(x, y, c);
    }
    p.set(24 - half - 1, y, INK).set(24 + half, y, INK);
    if (y > 7) p.set(24 - half, y, t.light);
  }
  p.rect(22, 6, 4, 1, INK);
  p.rect(3, 23, 42, 2, t.dark).rect(3, 23, 42, 1, t.main).rect(3, 25, 42, 1, INK);
  p.set(2, 23, INK).set(2, 24, INK).set(45, 23, INK).set(45, 24, INK);
  // 屋頂上的徽章
  p.rect(21, 13, 6, 6, t.light).rect(22, 12, 4, 1, t.light).rect(22, 19, 4, 1, t.light);
  p.line(22, 18, 25, 15, PAL.n).set(23, 14, PAL.Z).set(24, 14, PAL.Z).set(25, 14, PAL.Z).set(26, 15, PAL.Z).set(26, 16, PAL.Z);
  // 門
  p.rect(20, 29, 8, 12, PAL.N).rect(21, 28, 6, 1, PAL.N);
  p.rect(21, 30, 6, 11, '#c45a12').rect(22, 32, 4, 9, '#f08a1e').rect(22, 35, 4, 6, '#ffd24a').rect(23, 38, 2, 3, '#fff3b0');
  // 窗戶
  for (const wx of [12, 30]) {
    p.rect(wx, 27, 6, 6, PAL.N).rect(wx + 1, 28, 4, 4, '#ffd98a');
    p.set(wx + 1, 28, '#fff3b0').set(wx + 2, 28, '#fff3b0');
    p.rect(wx + 1, 30, 4, 1, PAL.N).rect(wx + 3, 28, 1, 4, PAL.N);
    p.rect(wx, 33, 6, 1, PAL.m);
  }
  // 門邊的提燈
  p.set(18, 30, PAL.Z).set(18, 31, '#fff3b0').set(18, 32, '#ffd24a').set(29, 30, PAL.Z).set(29, 31, '#fff3b0').set(29, 32, '#ffd24a');
  // 木桶
  p.rect(3, 34, 5, 8, PAL.n).rect(3, 34, 1, 8, PAL.m).rect(7, 34, 1, 8, PAL.N).rect(3, 36, 5, 1, PAL.Z).rect(3, 40, 5, 1, PAL.Z).rect(3, 33, 5, 1, INK).rect(3, 42, 5, 1, INK);
  // 礦車與金塊
  p.rect(38, 37, 8, 4, PAL.Z).rect(38, 37, 8, 1, PAL.h).rect(39, 41, 6, 1, PAL.z);
  p.set(39, 42, PAL.z).set(40, 42, PAL.z).set(43, 42, PAL.z).set(44, 42, PAL.z);
  p.rect(39, 35, 6, 2, PAL.y).set(40, 34, PAL.y).set(41, 34, PAL.Y).set(43, 34, PAL.y).set(39, 35, PAL.Y).set(42, 35, PAL.Y).set(44, 36, PAL.v);
  // 旗桿（旗子在畫面上另外畫，會飄）
  p.rect(42, 3, 1, 19, PAL.c).set(42, 2, PAL.y).set(41, 2, INK).set(43, 2, INK).set(42, 1, INK);
  return p;
}

// 把 #rrggbb 調暗或調亮
export function shade(hex, f) {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${[ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// ======================= 地形 =======================

function sprinkle(p, r, n, c, w = 1, h = 1) {
  for (let k = 0; k < n; k++) p.rect(Math.floor(r() * S), Math.floor(r() * S), w, h, c);
}

export function dirtPix(seed) {
  const r = mulberry32(seed);
  const p = new Pix().rect(0, 0, S, S, PAL.b);
  sprinkle(p, r, 30, '#6d482b');
  sprinkle(p, r, 18, '#86603c');
  sprinkle(p, r, 7, PAL.D, 2, 1);
  sprinkle(p, r, 5, PAL.B);
  // 一兩道深色的土層紋
  for (let k = 0; k < 2; k++) {
    const y = 1 + Math.floor(r() * 14);
    let x = Math.floor(r() * 6);
    const len = 4 + Math.floor(r() * 7);
    for (let i = 0; i < len && x < S; i++, x++) if (r() < 0.8) p.set(x, y + (r() < 0.2 ? 1 : 0), '#63412a');
  }
  // 小石頭
  for (let k = 0; k < 2; k++) {
    const x = 1 + Math.floor(r() * 12);
    const y = 1 + Math.floor(r() * 12);
    p.set(x, y, '#a58d72').set(x + 1, y, '#8f775c').set(x, y + 1, '#8f775c').set(x + 1, y + 1, '#6b553f');
    p.set(x, y + 2, '#573a22').set(x + 1, y + 2, '#573a22');
  }
  return p;
}

export function hardPix(seed) {
  const r = mulberry32(seed);
  const p = new Pix().rect(0, 0, S, S, '#665347');
  sprinkle(p, r, 28, '#59483d');
  sprinkle(p, r, 16, '#75625a');
  // 嵌在土裡的石塊
  for (let k = 0; k < 3; k++) {
    const w = 3 + Math.floor(r() * 3);
    const h = 2 + Math.floor(r() * 2);
    const x = Math.floor(r() * (S - w));
    const y = Math.floor(r() * (S - h - 1));
    p.rect(x, y, w, h, '#8e8782').rect(x, y, w, 1, '#aaa39e').rect(x, y + h, w, 1, '#3f332c');
    p.set(x + w - 1, y, '#8e8782').set(x + w - 1, y + h - 1, '#6f6964');
  }
  // 裂痕
  let x = 2 + Math.floor(r() * 5);
  let y = 1 + Math.floor(r() * 4);
  for (let k = 0; k < 9 && x < S && y < S; k++) {
    p.set(x, y, '#3a2e27');
    if (r() < 0.6) x++;
    if (r() < 0.7) y++;
  }
  return p;
}

// 石頭：不規則的石塊堆在一起
export function rockPix(seed) {
  const r = mulberry32(seed);
  const p = new Pix().rect(0, 0, S, S, '#2f3139');
  const rows = [0, 5, 10, 16];
  for (let j = 0; j < 3; j++) {
    const y0 = rows[j];
    const y1 = rows[j + 1];
    let x = j % 2 ? -3 : 0;
    while (x < S) {
      const w = 5 + Math.floor(r() * 4);
      const base = ['#5d6272', '#666b7c', '#565b6a'][Math.floor(r() * 3)];
      for (let yy = y0; yy < y1 - 1; yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(S, x + w - 1); xx++) {
          let c = base;
          if (yy === y0) c = '#8a90a2';
          else if (xx === x) c = '#787e90';
          else if (yy === y1 - 2 || xx === x + w - 2) c = '#474b58';
          p.set(xx, yy, c);
        }
      }
      if (x + 2 < S && x + 2 >= 0 && r() < 0.6) p.set(x + 2 + Math.floor(r() * 2), y0 + 2, '#4d515e');
      x += w;
    }
  }
  return p;
}

export function floorPix(seed) {
  const r = mulberry32(seed);
  const p = new Pix().rect(0, 0, S, S, '#2a2320');
  sprinkle(p, r, 26, '#241d1a');
  sprinkle(p, r, 18, '#332a26');
  sprinkle(p, r, 4, '#3d332e', 2, 1);
  for (let k = 0; k < 2; k++) {
    const x = 1 + Math.floor(r() * 13);
    const y = 5 + Math.floor(r() * 9);
    p.set(x, y, PAL.f).set(x + 1, y, '#3d332e').set(x, y + 1, '#1a1513');
  }
  return p;
}

export function unknownPix(seed) {
  const r = mulberry32(seed);
  const p = new Pix().rect(0, 0, S, S, '#0e0b10');
  sprinkle(p, r, 22, '#15111a');
  sprinkle(p, r, 10, '#09070b');
  return p;
}

// 金礦：幾顆金塊（疊在土上）
export function orePix(seed) {
  const r = mulberry32(seed);
  const p = new Pix();
  for (let k = 0; k < 4; k++) {
    const x = 2 + Math.floor(r() * 10);
    const y = 2 + Math.floor(r() * 10);
    const big = r() < 0.5;
    p.rect(x, y, big ? 3 : 2, 2, PAL.y).set(x, y, PAL.Y).set(x + (big ? 2 : 1), y + 1, PAL.v);
    if (big) p.set(x + 1, y - 1, PAL.y);
  }
  return p.outline('#5a3a0c');
}

export function mudPix(seed) {
  const r = mulberry32(seed);
  const p = new Pix();
  for (let k = 0; k < 3; k++) {
    const cx = 4 + Math.floor(r() * 8);
    const cy = 4 + Math.floor(r() * 8);
    const rx = 3 + Math.floor(r() * 2);
    for (let y = -2; y <= 2; y++) {
      const w = y === -2 || y === 2 ? rx - 2 : rx;
      for (let x = -w; x <= w; x++) p.set(cx + x, cy + y, y === -2 ? '#8a6a45' : '#6b4a2b');
    }
    p.set(cx - 1, cy - 1, '#a5845c').set(cx, cy - 1, '#a5845c');
  }
  return p.outline('#3d2a18');
}

// 通道上緣露出的岩壁（16×6），讓通道看起來是往下挖出來的。kind: 0 土、1 硬土、2 石頭
const FACE_COL = [
  ['#b8875a', '#6d482b', '#553722', '#3a2415'],
  ['#9f958e', '#59483d', '#45372e', '#2c221c'],
  ['#a3a8b6', '#565b6a', '#40434f', '#27292f'],
];
export function facePix(kind, seed) {
  const r = mulberry32(seed);
  const [rim, mid, dark, deep] = FACE_COL[kind];
  const p = new Pix(S, 6);
  for (let x = 0; x < S; x++) {
    p.set(x, 0, rim).set(x, 1, mid).set(x, 2, mid).set(x, 3, dark).set(x, 4, dark);
    // 下緣參差不齊
    if (r() < 0.7) p.set(x, 5, deep);
    if (r() < 0.15) p.set(x, 1, dark);
    if (r() < 0.12) {
      p.set(x, 2, deep);
      p.set(x, 3, deep);
    }
  }
  return p;
}

// 地圖上的小裝飾（畫在地形上）：[名稱, 圖]
const DECOR = {
  fossil: ['.ccc.', 'c...c', 'c.c.c', 'c..cc', '.cc..'],
  bone: ['c....c', 'cccccc', 'c....c'],
  root: ['d.....', '.dd...', '...d..', '...dd.', '.....d'],
  rubble: ['..f..', '.fSf.', 'fSsSf'],
  plank: ['mmmmmmm', 'nnnnnnn'],
  shroom: ['.rr.', 'rwrr', '.cc.', '.cc.'],
  puddle: ['.IIII.', 'IiIIII', '.IIII.'],
  crystal: ['..i..', '.iwi.', '.iIi.', 'iIiIi'],
  moss: ['l.ll.', '.lLl.'],
};
export function decorPix(name) {
  const rows = DECOR[name];
  return new Pix(rows[0].length, rows.length).ascii(rows, null, 0, 0, `decor ${name}`);
}
export const DECOR_NAMES = Object.keys(DECOR);

// 坑道的木頭支架（16×16，疊在通道上）
const SUPPORT = [
  'nmmmmmmmmmmmmmmN',
  'nnnnnnnnnnnnnnnN',
  'NNNNNNNNNNNNNNNN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
  'mnN..........mnN',
];
export const supportPix = () => new Pix().ascii(SUPPORT, null, 0, 0, 'support');

// ======================= 道具圖示（16×16） =======================

const ICON = {
  bomb: [
    '................',
    '..........oY....',
    '.........n.o....',
    '........n.......',
    '.......ZZ.......',
    '.....zzzzzz.....',
    '....zzZZzzzz....',
    '...zzZwZzzzzz...',
    '...zzZZzzzzzz...',
    '...zzzzzzzzzz...',
    '...zzzzzzzzzz...',
    '....zzzzzzzz....',
    '.....zzzzzz.....',
    '................',
    '................',
    '................',
  ],
  intel1: [
    '................',
    '................',
    '..cccccccccccc..',
    '..cccccccccccc..',
    '..cNcccrrccccc..',
    '..ccNcrccrcccc..',
    '..cccNcccrcccc..',
    '..ccNcccrccccc..',
    '..cNccccrccccc..',
    '..ccNccccccccc..',
    '..cccNccrccccc..',
    '..cccccccccccc..',
    '..CCCCCCCCCCCC..',
    '................',
    '................',
    '................',
  ],
  intel2: [
    '................',
    '................',
    '..cccccccccccc..',
    '..cccccrrrcccc..',
    '..cNccrcccrccc..',
    '..ccNcrcrcrccc..',
    '..cccNrcccrccc..',
    '..ccNccrrrcccc..',
    '..cNcccccccccc..',
    '..ccNccccccccc..',
    '..cccNcccccccc..',
    '..cccccccccccc..',
    '..CCCCCCCCCCCC..',
    '................',
    '................',
    '................',
  ],
  boots: [
    '................',
    '................',
    '................',
    '......nnnn......',
    '......nmnn......',
    '..ww..nmnn......',
    '......nnnn......',
    '.www..nnnn......',
    '......nnnnn.....',
    '..ww..nnnnnnn...',
    '.....nnnnnnnnn..',
    '.....NNNNNNNNN..',
    '................',
    '................',
    '................',
    '................',
  ],
  hard: [
    '................',
    '................',
    '................',
    '..hhhhhhhhhhhh..',
    '..hGGGGgGGGGGg..',
    '..hGGGGgGGGGGg..',
    '..gggggggggggg..',
    '..hGGgGGGGGgGG..',
    '..hGGgGGGGGgGG..',
    '..gggggggggggg..',
    '..hGGGGgGGGGGg..',
    '..hGGGGgGGGGGg..',
    '..gggggggggggg..',
    '................',
    '................',
    '................',
  ],
  mud: [
    '................',
    '................',
    '................',
    '................',
    '.......B........',
    '......bbbb...B..',
    '....bbbBBbbb....',
    '...bbBBbbbbbb...',
    '..bbbbbbbbDbbb..',
    '..bDbbbbbbbbbb..',
    '..bbbbbDDbbbbb..',
    '...dddddddddd...',
    '................',
    '................',
    '................',
    '................',
  ],
  scope: [
    '................',
    '................',
    '................',
    '................',
    '.............H..',
    '........NYYYYHi.',
    '....YYYYNYYYYHw.',
    '.NNnyyyyNyyyyHi.',
    '.NNnyyyyNyyyyHi.',
    '....vvvvNyyyyHI.',
    '........NvvvvHI.',
    '.............H..',
    '................',
    '................',
    '................',
    '................',
  ],
  fake: [
    '................',
    '................',
    '.......hh.......',
    '......hGGh......',
    '.....hGGGGh.....',
    '....hGGGGGGh....',
    '...hGGGGGGGGh...',
    '...cccccccccc...',
    '...ccrrccnncc...',
    '...cccrccnncc...',
    '...ccrcccnncc...',
    '...cccccCnncc...',
    '...ccrcccnncc...',
    '................',
    '................',
    '................',
  ],
  miner: [
    '................',
    '................',
    '....yyyyyy......',
    '...yyyYYyyy.....',
    '...vvvvvvvv.....',
    '....qqqqqq......',
    '....qxqqxq..ee..',
    '....qqqqqq.eeee.',
    '.....QqqQ...ee..',
    '...uuuuuuuu.....',
    '...uuUUUUuu.....',
    '...uuuuuuuu.....',
    '................',
    '................',
    '................',
    '................',
  ],
  tnt: [
    '................',
    '.........oY.....',
    '........n.......',
    '.......n........',
    '..rrrrrrrrrrrr..',
    '..RrrRRrrRRrrR..',
    '..RrrRRrrRRrrR..',
    '..cccccccccccc..',
    '..cNNcNNcNNcNc..',
    '..cccccccccccc..',
    '..RrrRRrrRRrrR..',
    '..RrrRRrrRRrrR..',
    '..RRRRRRRRRRRR..',
    '................',
    '................',
    '................',
  ],
};

export const ICON_IDS = ['bomb', 'intel1', 'intel2', 'snuff', 'scope', 'boots', 'pick', 'hard', 'mud', 'laser', 'spike', 'spell', 'fake', 'portal', 'miner', 'tnt'];

export function iconPix(id) {
  if (ICON[id]) return new Pix().ascii(ICON[id], null, 0, 0, `icon ${id}`).outline();
  if (id === 'spell') {
    // 深藍色圓底上的一片雪花
    const p = new Pix();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = (x - 7) * (x - 7) + (y - 7) * (y - 7);
        if (d <= 42) p.set(x, y, d <= 30 && x + y < 13 ? '#2c5aa8' : '#1f3f7a');
      }
    }
    for (let k = -5; k <= 5; k++) p.set(7 + k, 7, PAL.i).set(7, 7 + k, PAL.i);
    for (let k = -3; k <= 3; k++) p.set(7 + k, 7 + k, PAL.i).set(7 + k, 7 - k, PAL.i);
    for (const [x, y] of [[6, 3], [8, 3], [6, 11], [8, 11], [3, 6], [3, 8], [11, 6], [11, 8]]) p.set(x, y, PAL.i);
    for (const [x, y] of [[7, 7], [7, 2], [7, 12], [2, 7], [12, 7]]) p.set(x, y, PAL.w);
    return p.outline();
  }
  if (id === 'laser') return laserPix(1);
  if (id === 'spike') return spikePix();
  if (id === 'portal') return portalPix(0);
  if (id === 'snuff') {
    // 火把上面打一個紅色的叉
    const p = torchPix(-1, 0);
    for (let k = 0; k < 11; k++) {
      p.set(2 + k, 2 + k, PAL.r).set(3 + k, 2 + k, PAL.R);
      p.set(13 - k, 2 + k, PAL.r).set(12 - k, 2 + k, PAL.R);
    }
    return p;
  }
  if (id === 'pick') {
    const p = new Pix();
    p.line(3, 13, 10, 6, PAL.n).line(4, 13, 11, 6, PAL.N);
    p.line(5, 3, 10, 4, PAL.H).line(10, 4, 13, 9, PAL.H).line(5, 4, 9, 5, PAL.h).line(10, 5, 12, 9, PAL.h);
    return p.outline();
  }
  throw new Error(`沒有「${id}」這個道具圖示`);
}
