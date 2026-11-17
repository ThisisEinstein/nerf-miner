// 畫面繪製（像素風）。只讀「玩家視角」（sim/view.js 產生的 view）。
// 所有座標都以螢幕的實體像素計算，圖一律用整數倍放大、不做平滑，所以每個像素都是清楚的方塊。
// 地形先畫在一張 16 像素一格的離屏大圖上，只有變動的格子才重畫。
import { W, H, N, T, UNKNOWN, idx } from '../sim/constants.js';
import { Sprites, TEAM } from './sprites.js';
import { INK } from './pixels.js';
import { isCapturing } from './ui.js';

const S = 16; // 一格的原始像素數
const TAU = Math.PI * 2;
const hash = (i) => {
  let h = Math.imul(i + 1, 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
};
const FX_DUR = { laser: 0.45, boom: 0.9, hit: 0.25, death: 1.1, freeze: 0.8, spike: 0.45, snuff: 0.7, coin: 1.0, capture: 1.0, order: 0.45, alert: 2.2 };
const DUST = { [T.DIRT]: ['#96683f', '#7a5232', '#b8875a'], [T.HARD]: ['#8e8782', '#665347', '#aaa39e'], [T.ROCK]: ['#868c9e', '#5a5f6e', '#bcc2d2'] };
// 小地圖上各種地形的顏色
const MINI = { [T.DIRT]: [112, 78, 48], [T.HARD]: [92, 76, 66], [T.ROCK]: [98, 103, 118], [T.FLOOR]: [46, 38, 34] };

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.sp = new Sprites();
    this.k = 0; // 放大倍率（整數）
    this.map = false; // 大地圖模式：整張地圖縮到畫面裡
    this.mapT = 8;
    this.cam = { x: 0, y: 0 }; // 鏡頭位置（實體像素）
    this.inset = { l: 0, t: 0, r: 0, b: 0 }; // 被介面擋住的邊（CSS 像素）
    this.fx = [];
    this.parts = [];
    this.v = null;
    this.team = 0;
    this.time = 0;
    this.shake = 0;
    this.lknow = new Uint8Array(N).fill(254);
    this.lore = new Uint8Array(N);
    this.dirty = new Uint8Array(N);
    this.layer = document.createElement('canvas');
    this.layer.width = W * S;
    this.layer.height = H * S;
    this.lctx = this.layer.getContext('2d');
    this.fog = document.createElement('canvas');
    this.fog.width = W * 2;
    this.fog.height = H * 2;
    this.fogCtx = this.fog.getContext('2d');
    this.fogData = this.fogCtx.createImageData(W * 2, H * 2);
    this.miniSrc = document.createElement('canvas');
    this.miniSrc.width = W;
    this.miniSrc.height = H;
    this.miniCtx = this.miniSrc.getContext('2d');
    this.miniData = this.miniCtx.createImageData(W, H);
    this.resize();
  }

  // ---------- 尺寸與鏡頭 ----------

  // 可用的放大倍率：一格在螢幕上大約 18–64 個 CSS 像素
  get kMin() {
    return Math.max(1, Math.ceil((18 * this.dpr) / S));
  }
  get kMax() {
    return Math.max(this.kMin, Math.floor((64 * this.dpr) / S));
  }
  // 一格的實體像素數
  get T() {
    return this.map ? this.mapT : S * this.k;
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(this.cv.clientWidth * this.dpr);
    this.cv.height = Math.round(this.cv.clientHeight * this.dpr);
    this.dw = this.cv.width;
    this.dh = this.cv.height;
    if (!this.k) this.k = Math.round(2 * this.dpr);
    this.k = Math.min(this.kMax, Math.max(this.kMin, this.k));
    this.mapT = this.fitT();
    this.clamp();
  }

  reset(team) {
    this.team = team;
    this.v = null;
    this.fx = [];
    this.parts = [];
    this.shake = 0;
    this.lknow.fill(254);
  }

  setView(v) {
    this.v = v;
  }

  // 沒被介面擋住的區域（實體像素）
  get area() {
    const d = this.dpr;
    const x = this.inset.l * d;
    const y = this.inset.t * d;
    return { x, y, w: this.dw - x - this.inset.r * d, h: this.dh - y - this.inset.b * d };
  }

  get viewCenter() {
    const a = this.area;
    return { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  }

  // 整張地圖剛好放進可用區域時，一格是幾個實體像素
  fitT() {
    const a = this.area;
    const m = 16 * this.dpr;
    return Math.max(4, Math.floor(Math.min((a.w - m) / W, (a.h - m) / H)));
  }

  clamp() {
    const a = this.area;
    const pad = Math.round(20 * this.dpr);
    const T2 = this.T;
    const fix = (v, min, max) => Math.round(max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v)));
    this.cam.x = fix(this.cam.x, -a.x - pad, W * T2 - (a.x + a.w) + pad);
    this.cam.y = fix(this.cam.y, -a.y - pad, H * T2 - (a.y + a.h) + pad);
  }

  centerOn(tx, ty) {
    const c = this.viewCenter;
    this.cam.x = (tx + 0.5) * this.T - c.x;
    this.cam.y = (ty + 0.5) * this.T - c.y;
    this.clamp();
  }

  // 以 CSS 像素為單位平移鏡頭
  panBy(dx, dy) {
    this.cam.x += dx * this.dpr;
    this.cam.y += dy * this.dpr;
    this.clamp();
  }

  // 滑鼠位置（CSS 像素）在地圖的哪一格
  tileAt(px, py) {
    const t = this.T;
    return { x: Math.floor((px * this.dpr + this.cam.x) / t), y: Math.floor((py * this.dpr + this.cam.y) / t) };
  }

  // 換一個倍率或切到大地圖；(ax, ay) 是縮放時要固定不動的畫面位置（CSS 像素）
  zoomTo(k, map, ax, ay) {
    const c = this.viewCenter;
    const px = ax == null ? c.x : ax * this.dpr;
    const py = ay == null ? c.y : ay * this.dpr;
    const wx = (this.cam.x + px) / this.T;
    const wy = (this.cam.y + py) / this.T;
    this.map = map;
    if (!map) this.k = Math.min(this.kMax, Math.max(this.kMin, k));
    else this.mapT = this.fitT();
    this.cam.x = wx * this.T - px;
    this.cam.y = wy * this.T - py;
    this.clamp();
  }

  // 滾輪縮放：dir > 0 放大。縮到最小再縮就是大地圖
  zoomStep(dir, ax, ay) {
    if (dir > 0) {
      if (this.map) this.zoomTo(this.kMin, false, ax, ay);
      else this.zoomTo(this.k + 1, false, ax, ay);
    } else if (!this.map) {
      if (this.k > this.kMin) this.zoomTo(this.k - 1, false, ax, ay);
      else this.zoomTo(this.k, true, ax, ay);
    }
  }

  setMap(on) {
    this.zoomTo(this.k, on);
  }

  // ---------- 特效 ----------

  burst(x, y, n, colors, speed, life, g = 3, big = false) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU;
      const s = speed * (0.35 + Math.random() * 0.65);
      const l = life * (0.5 + Math.random() * 0.5);
      this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, g, life: l, max: l, big: big && Math.random() < 0.5, color: colors[k % colors.length] });
    }
    if (this.parts.length > 700) this.parts.splice(0, this.parts.length - 700);
  }

  addFx(e) {
    this.fx.push({ ...e, t0: performance.now() / 1000 });
    const x = e.x + 0.5;
    const y = e.y + 0.5;
    const tc = e.team >= 0 ? TEAM[e.team] : null;
    switch (e.kind) {
      case 'boom':
        this.burst(x, y, e.big ? 70 : 40, ['#ffb347', '#f08a1e', '#fff3b0', '#8a7a6a', '#5a4a3a'], e.big ? 9 : 6, 0.9, 5, true);
        this.shake = Math.max(this.shake, e.big ? 1.4 : 0.7);
        break;
      case 'coin':
        this.burst(x, y, 9, ['#ffd24a', '#fff3b0', '#c9912a'], 2.4, 0.7, 5);
        break;
      case 'death':
        this.burst(x, y, 16, tc ? [tc.main, tc.light, '#ffffff'] : ['#ffffff'], 3, 0.8, 4);
        break;
      case 'capture':
        this.burst(x, y, 22, tc ? [tc.main, '#ffe27a', tc.light] : ['#ffe27a'], 3.2, 0.9, 0.5);
        break;
      case 'hit':
        this.burst(x, y, 7, ['#ffffff', '#ffe27a'], 3, 0.3, 0);
        this.shake = Math.max(this.shake, 0.12);
        break;
      case 'freeze':
        this.burst(x, y, 26, ['#9fe3ff', '#ffffff', '#3a8fc4'], 4.5, 0.8, 0);
        break;
      case 'snuff':
        this.burst(x, y, 16, ['#888888', '#aaaaaa', '#666666'], 1.6, 0.9, -1.5, true);
        break;
      case 'spike':
        this.burst(x, y, 10, ['#bcc2d2', '#868c9e', '#e23b33'], 3, 0.4, 4);
        break;
      case 'laser':
        this.burst(e.x2 + 0.5, e.y2 + 0.5, 12, ['#e23b33', '#ffd0c4', '#ff9a8c'], 3.5, 0.45, 2);
        break;
    }
  }

  minerPos(m, alpha) {
    let x = m.x;
    let y = m.y;
    const a = m.act;
    if (a && a.to >= 0 && (a.kind === 'walk' || a.kind === 'dig')) {
      const tx = a.to % W;
      const ty = (a.to / W) | 0;
      const p = a.kind === 'walk' ? Math.min(1, Math.max(0, 1 - (a.left - alpha) / a.total)) : Math.floor(this.time * 6 + m.id) % 2 ? 0.19 : 0.06;
      x += (tx - x) * p;
      y += (ty - y) * p;
    }
    return { x, y };
  }

  // ---------- 地形大圖 ----------

  syncTerrain(v) {
    const know = v.know;
    const ore = v.ore;
    const lk = this.lknow;
    const lo = this.lore;
    const d = this.dirty;
    let any = false;
    for (let i = 0; i < N; i++) {
      if (know[i] === lk[i] && ore[i] === lo[i]) continue;
      lk[i] = know[i];
      lo[i] = ore[i];
      any = true;
      d[i] = 1;
      const x = i % W;
      if (i >= W) d[i - W] = 1;
      if (i < N - W) d[i + W] = 1;
      if (x > 0) d[i - 1] = 1;
      if (x < W - 1) d[i + 1] = 1;
    }
    if (!any) return;
    const tex = this.sp.tiles();
    for (let i = 0; i < N; i++) {
      if (!d[i]) continue;
      d[i] = 0;
      this.drawTile(i, know, ore, tex);
    }
  }

  drawTile(i, know, ore, tex) {
    const L = this.lctx;
    const tx = i % W;
    const ty = (i / W) | 0;
    const px = tx * S;
    const py = ty * S;
    const hv = hash(i);
    const dv = hv >>> 7;
    const k = know[i];
    if (k === UNKNOWN) {
      L.drawImage(tex.unknown[hv % tex.unknown.length], px, py);
      return;
    }
    const set = k === T.DIRT ? tex.dirt : k === T.HARD ? tex.hard : k === T.ROCK ? tex.rock : tex.floor;
    L.drawImage(set[hv % set.length], px, py);
    const at = (dx, dy) => {
      const x = tx + dx;
      const y = ty + dy;
      return x < 0 || y < 0 || x >= W || y >= H ? T.ROCK : know[y * W + x];
    };
    const n = at(0, -1);
    const s = at(0, 1);
    const w = at(-1, 0);
    const e = at(1, 0);
    const dark = (a, x, y, ww, hh) => {
      L.fillStyle = `rgba(0,0,0,${a})`;
      L.fillRect(px + x, py + y, ww, hh);
    };
    const deco = (name, x, y) => L.drawImage(tex.decor[name], px + x, py + y);
    if (k === T.FLOOR) {
      const solid = (q) => q !== T.FLOOR && q !== UNKNOWN;
      const sn = solid(n);
      const ss = solid(s);
      const sw = solid(w);
      const se = solid(e);
      // 地上的小東西（先畫，才會被岩壁的影子蓋到）
      const ox = 2 + (dv % 8);
      if (dv % 9 === 0) deco('rubble', ox, 11);
      else if (dv % 31 === 1) deco('plank', 2 + (dv % 6), 10);
      else if (dv % 43 === 2) deco('shroom', ox + 1, 10);
      else if (dv % 47 === 3) deco('bone', ox, 11);
      else if (dv % 37 === 4) deco('puddle', ox, 11);
      if (sw) {
        dark(0.38, 0, 0, 1, S);
        dark(0.18, 1, 0, 1, S);
      }
      if (se) {
        dark(0.38, S - 1, 0, 1, S);
        dark(0.18, S - 2, 0, 1, S);
      }
      if (ss) {
        dark(0.34, 0, S - 1, S, 1);
        dark(0.14, 0, S - 2, S, 1);
      }
      if (sn) {
        // 上面是實心的：露出一截岩壁，下面有影子
        L.drawImage(tex.face[n][(hv >>> 4) % 4], px, py);
        dark(0.45, 0, 6, S, 1);
        dark(0.28, 0, 7, S, 1);
        dark(0.12, 0, 8, S, 1);
      }
      // 橫向的坑道偶爾有木頭支架
      if (sn && ss && !sw && !se && dv % 3 === 0) L.drawImage(tex.support, px, py);
      return;
    }
    // 讓每格的明暗稍微不同
    const tone = (hv >>> 9) % 6;
    if (tone < 2) dark(0.07, 0, 0, S, S);
    else if (tone === 5) {
      L.fillStyle = 'rgba(255,255,255,.04)';
      L.fillRect(px, py, S, S);
    }
    if (k !== T.ROCK && ore[i]) L.drawImage(tex.ore[(hv >>> 3) % tex.ore.length], px, py);
    else if (k === T.DIRT) {
      if (dv % 17 === 0) deco('fossil', 3 + (dv % 7), 4 + ((dv >>> 3) % 6));
      else if (dv % 13 === 1) deco('root', 2 + (dv % 8), 3 + ((dv >>> 3) % 7));
      else if (dv % 29 === 2) deco('bone', 3 + (dv % 6), 5 + ((dv >>> 3) % 7));
    } else if (k === T.ROCK) {
      if (dv % 13 === 0) deco('crystal', 3 + (dv % 8), 4 + ((dv >>> 3) % 6));
      else if (dv % 7 === 1) deco('moss', 2 + (dv % 9), 1 + ((dv >>> 3) % 3) * 5);
    }
    if (n === T.FLOOR) {
      L.fillStyle = 'rgba(255,236,205,.22)';
      L.fillRect(px, py, S, 1);
    }
    if (w === T.FLOOR) dark(0.3, 0, 0, 1, S);
    if (e === T.FLOOR) dark(0.3, S - 1, 0, 1, S);
  }

  updateFog(v) {
    const d = this.fogData.data;
    const FW = W * 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const a = v.know[i] === UNKNOWN ? 244 : v.vis[i] ? 0 : 148;
        for (let q = 0; q < 4; q++) {
          const o = ((y * 2 + (q >> 1)) * FW + x * 2 + (q & 1)) * 4;
          d[o] = 5;
          d[o + 1] = 5;
          d[o + 2] = 13;
          d[o + 3] = a;
        }
      }
    }
    this.fogCtx.putImageData(this.fogData, 0, 0);
  }

  // ---------- 小地圖 ----------

  // 把目前的視角畫成小地圖（mc 是另一張 canvas）
  drawMini(mc) {
    const v = this.v;
    const x = mc.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = '#07060a';
    x.fillRect(0, 0, mc.width, mc.height);
    if (!v) return;
    const d = this.miniData.data;
    for (let i = 0; i < N; i++) {
      const k = v.know[i];
      let c = k === UNKNOWN ? [12, 10, 15] : MINI[k];
      if (k === T.FLOOR && v.lit[i]) c = [112, 84, 50];
      const f = k === UNKNOWN || v.vis[i] ? 1 : 0.55;
      d[i * 4] = c[0] * f;
      d[i * 4 + 1] = c[1] * f;
      d[i * 4 + 2] = c[2] * f;
      d[i * 4 + 3] = 255;
    }
    this.miniCtx.putImageData(this.miniData, 0, 0);
    x.imageSmoothingEnabled = false;
    x.drawImage(this.miniSrc, 0, 0, mc.width, mc.height);
    const s = mc.width / W;
    const box = (tx, ty, n, color) => {
      x.fillStyle = color;
      x.fillRect(Math.round((tx - (n - 1) / 2) * s), Math.round((ty - (n - 1) / 2) * s), Math.ceil(n * s), Math.ceil(n * s));
    };
    for (const mn of v.mines) box(mn.x, mn.y, 2, mn.owner < 0 ? '#d9cfa8' : TEAM[mn.owner].light);
    if (!v.treasure.taken) box(v.treasure.x, v.treasure.y, 2, '#ffd24a');
    for (const h of v.homes) {
      box(h.cx, h.cy, 4, '#ffffff');
      box(h.cx, h.cy, 3, TEAM[h.team].main);
    }
    if (v.intelZone) {
      const z = v.intelZone;
      x.strokeStyle = TEAM[1 - this.team].main;
      x.lineWidth = Math.max(1, Math.round(s / 2));
      x.strokeRect(z.x * s + 0.5, z.y * s + 0.5, z.w * s, z.h * s);
    }
    for (const m of v.miners) {
      if (m.state === 'fountain') continue;
      box(m.x, m.y, 2, m.team === this.team ? '#ffffff' : TEAM[m.team].main);
    }
    // 警報的位置閃紅框
    for (const f of this.fx) {
      if (f.kind !== 'alert' || Math.floor(this.time * 6) % 2) continue;
      x.strokeStyle = '#ff4040';
      x.lineWidth = Math.max(2, Math.round(s));
      x.strokeRect((f.x - 2.5) * s, (f.y - 2.5) * s, 6 * s, 6 * s);
    }
    // 目前畫面看到的範圍
    const t = this.T;
    const a = this.area;
    x.strokeStyle = '#ffffff';
    x.lineWidth = Math.max(1, Math.round(this.dpr));
    x.strokeRect(((this.cam.x + a.x) / t) * s + 0.5, ((this.cam.y + a.y) / t) * s + 0.5, (a.w / t) * s, (a.h / t) * s);
  }

  // ---------- 主繪製 ----------

  // ui: { sel: [id…], hover: {x,y}|null, preview: { tiles:[i…], rgb:'r,g,b' }|null }
  draw(alpha, ui) {
    const c = this.ctx;
    const v = this.v;
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0, now - this.time));
    this.time = now;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#050408';
    c.fillRect(0, 0, this.dw, this.dh);
    if (!v) return;
    this.syncTerrain(v);
    this.updateFog(v);

    const sp = this.sp;
    const tex = sp.tiles();
    const me = this.team;
    const know = v.know;
    const vis = v.vis;
    const time = this.time;
    const dpr = this.dpr;
    const small = this.map;
    const Tp = this.T; // 一格的實體像素
    const k = small ? Math.max(1, Math.round(Tp / S)) : this.k; // 一個「像素」的大小
    const sc = Tp / S;
    let cx = Math.round(this.cam.x);
    let cy = Math.round(this.cam.y);
    if (this.shake > 0.02) {
      cx += Math.round(((Math.random() - 0.5) * this.shake * Tp * 0.45) / k) * k;
      cy += Math.round(((Math.random() - 0.5) * this.shake * Tp * 0.45) / k) * k;
      this.shake *= Math.pow(0.012, dt);
    } else this.shake = 0;
    const x0 = Math.max(0, Math.floor(cx / Tp));
    const x1 = Math.min(W - 1, Math.floor((cx + this.dw) / Tp));
    const y0 = Math.max(0, Math.floor(cy / Tp));
    const y1 = Math.min(H - 1, Math.floor((cy + this.dh) / Tp));
    const SX = (x) => Math.round(x * Tp) - cx;
    const SY = (y) => Math.round(y * Tp) - cy;
    const fs = (css) => Math.round(css * dpr);
    c.imageSmoothingEnabled = small;
    c.imageSmoothingQuality = 'high';

    // 把一張像素圖畫在 (x, y)，每個像素放大成 sc 倍
    const img = (im, x, y, s = sc) => c.drawImage(im, x, y, Math.round(im.width * s), Math.round(im.height * s));
    const rect = (color, x, y, w, h) => {
      c.fillStyle = color;
      c.fillRect(x, y, w, h);
    };
    const label = (str, x, y, size, color) => {
      c.font = `700 ${fs(size)}px system-ui, "Microsoft JhengHei", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineWidth = Math.max(2, fs(3));
      c.lineJoin = 'round';
      c.strokeStyle = 'rgba(0,0,0,.85)';
      c.strokeText(str, x, y);
      c.fillStyle = color;
      c.fillText(str, x, y);
    };
    // 四個角的框線（選取、游標）
    const corners = (x, y, w, h, len, th, color) => {
      c.fillStyle = color;
      for (const [px, py, sx2, sy2] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
        c.fillRect(sx2 > 0 ? px : px - len, sy2 > 0 ? py : py - th, len, th);
        c.fillRect(sx2 > 0 ? px : px - th, sy2 > 0 ? py : py - len, th, len);
      }
    };
    const bar = (x, y, w, p, color) => {
      const h = 2 * k;
      rect(INK, x - k, y - k, w + 2 * k, h + 2 * k);
      rect('#3a3a3a', x, y, w, h);
      rect(color, x, y, Math.round((w * Math.min(1, Math.max(0, p))) / k) * k, h);
    };
    // 用小方塊排成的圓圈
    const ring = (x, y, r, color, size) => {
      c.fillStyle = color;
      const n = Math.max(12, Math.round((TAU * r) / (size * 2.2)));
      for (let q = 0; q < n; q++) {
        const a = (q / n) * TAU;
        c.fillRect(Math.round((x + Math.cos(a) * r) / k) * k, Math.round((y + Math.sin(a) * r) / k) * k, size, size);
      }
    };
    const light = (rgb, x, y, r, a) => {
      c.globalAlpha = a;
      c.drawImage(sp.glow(rgb), x - r, y - r, r * 2, r * 2);
    };

    // 1. 地形（只貼畫面上看得到的那一塊）
    {
      const ax = Math.max(0, cx / Tp);
      const ay = Math.max(0, cy / Tp);
      const bx = Math.min(W, (cx + this.dw) / Tp);
      const by = Math.min(H, (cy + this.dh) / Tp);
      if (bx > ax && by > ay) c.drawImage(this.layer, ax * S, ay * S, (bx - ax) * S, (by - ay) * S, Math.round(ax * Tp) - cx, Math.round(ay * Tp) - cy, Math.round((bx - ax) * Tp), Math.round((by - ay) * Tp));
    }

    // 2. 泥地、金礦的閃光
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (v.mud[i]) img(tex.mud[hash(i) % tex.mud.length], SX(x), SY(y));
        if (!small && v.ore[i] && vis[i] && know[i] !== T.FLOOR) {
          const ph = (time * 1.3 + (hash(i) % 100) / 14) % 3;
          if (ph < 0.4) {
            const hx = SX(x) + (3 + ((hash(i) >>> 5) % 9)) * k;
            const hy = SY(y) + (3 + ((hash(i) >>> 11) % 9)) * k;
            c.fillStyle = '#ffffff';
            c.fillRect(hx, hy - k, k, 3 * k);
            c.fillRect(hx - k, hy, 3 * k, k);
          }
        }
      }
    }

    // 3. 家
    let myHome = null;
    const ff = Math.floor(time * 5);
    for (const h of v.homes) {
      if (h.team === me && !h.fake) myHome = h;
      const hx = SX(h.cx - 1);
      const hy = SY(h.cy - 1);
      img(sp.home(h.team), hx, hy);
      if (!small) {
        img(sp.flag(h.team, ff % 4), hx + 43 * k, hy + 3 * k);
        // 煙囪的煙
        if (Math.random() < dt * 3) this.parts.push({ x: h.cx - 1 + 33.5 / S, y: h.cy - 1 + 5 / S, vx: 0.1 + Math.random() * 0.2, vy: -0.5 - Math.random() * 0.3, g: -0.1, life: 1.6, max: 1.6, big: Math.random() < 0.5, color: '#8a8580' });
      }
    }
    const tr = v.treasure;

    // 4. 設施與火把
    const pf = Math.floor(time * 8) % 4;
    for (const p of v.portals) {
      img(sp.portal(pf), SX(p.x), SY(p.y));
      rect(TEAM[p.team].main, SX(p.x) + 5 * k, SY(p.y) + 14 * k, 6 * k, k);
    }
    for (const L of v.lasers) img(sp.laser(L.team), SX(L.x), SY(L.y));
    for (const s of v.spikes) img(sp.spike(), SX(s.x), SY(s.y));
    const fl = Math.floor(time * 7);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        const t = v.torch[i];
        if (t) img(sp.torch(t - 1, (fl + i) % 3), SX(x), SY(y) - 2 * k);
      }
    }

    // 5. 迷霧（低解析度遮罩平滑放大，邊緣是柔的）
    c.imageSmoothingEnabled = true;
    c.drawImage(this.fog, -cx, -cy, W * Tp, H * Tp);
    c.imageSmoothingEnabled = small;

    // 6. 畫在迷霧上面的東西：礦井與大寶藏的位置是公開的，家的標示和情報範圍也要看得清楚
    for (const mn of v.mines) {
      const sx = SX(mn.x);
      const sy = SY(mn.y);
      img(sp.mine(), sx, sy);
      if (small) {
        rect(mn.owner < 0 ? '#d9cfa8' : TEAM[mn.owner].main, sx + Tp - 2 * k, sy - 2 * k, 4 * k, 3 * k);
      } else {
        rect('#e2d8c3', sx + 13 * k, sy - 6 * k, k, 8 * k);
        img(sp.flag(mn.owner, (ff + mn.id) % 4), sx + 14 * k, sy - 6 * k);
      }
      if (mn.prog > 0 && mn.progTeam >= 0) bar(sx + k, sy + Tp - 3 * k, Tp - 2 * k, mn.prog / 30, TEAM[mn.progTeam].main);
    }
    for (const h of v.homes) {
      const hx = SX(h.cx - 1) + Tp * 1.5;
      const hy = SY(h.cy - 1) - fs(8);
      if (h.team === me) {
        if (h.fake) label('假的家', hx, hy, 12, '#ffd98a');
      } else label(h.sure ? '敵方的家 ✔' : '敵方的家', hx, hy, 12, TEAM[h.team].light);
    }
    if (v.intelZone) {
      const z = v.intelZone;
      const zx = SX(z.x);
      const zy = SY(z.y);
      const zw = z.w * Tp;
      const zh = z.h * Tp;
      const foe = TEAM[1 - me];
      rect(`rgba(${foe.glow},${0.13 + 0.05 * Math.sin(time * 3)})`, zx, zy, zw, zh);
      // 會跑的虛線框
      const seg = 6 * k;
      const th = Math.max(2, k);
      const off = Math.floor(time * 12) * k;
      c.fillStyle = foe.main;
      for (let q = -seg * 2; q < Math.max(zw, zh); q += seg * 2) {
        const a = q + (off % (seg * 2));
        const dash = (from, to, max) => [Math.max(0, from), Math.min(max, to)];
        const [hx0, hx1] = dash(a, a + seg, zw);
        if (hx1 > hx0) {
          c.fillRect(zx + hx0, zy, hx1 - hx0, th);
          c.fillRect(zx + zw - hx1, zy + zh - th, hx1 - hx0, th);
        }
        const [vy0, vy1] = dash(a, a + seg, zh);
        if (vy1 > vy0) {
          c.fillRect(zx + zw - th, zy + vy0, th, vy1 - vy0);
          c.fillRect(zx, zy + zh - vy1, th, vy1 - vy0);
        }
      }
      label('敵方的家在這個範圍裡', zx + zw / 2, zy + fs(small ? 9 : 14), small ? 10 : 13, foe.light);
      label('？', zx + zw / 2, zy + zh / 2, small ? 24 : 44, `rgba(${foe.glow},.6)`);
    }
    if (!tr.taken) {
      const sx = SX(tr.x);
      const sy = SY(tr.y) - (Math.floor(time * 2) % 2) * k;
      img(sp.chest(), sx, sy);
      if (!small) {
        const q = Math.floor(time * 3) % 4;
        const [qx, qy] = [[3, 4], [12, 3], [10, 8], [5, 9]][q];
        c.fillStyle = '#fff3b0';
        c.fillRect(sx + qx * k, sy + (qy - 1) * k, k, 3 * k);
        c.fillRect(sx + (qx - 1) * k, sy + qy * k, 3 * k, k);
      }
      if (tr.prog > 0 && tr.progTeam >= 0) bar(sx + k, SY(tr.y) + Tp - 3 * k, Tp - 2 * k, tr.prog / 80, TEAM[tr.progTeam].main);
      if (small) label('寶', sx + Tp / 2, SY(tr.y) - fs(6), 11, '#ffd24a');
      else if (know[idx(tr.x, tr.y)] === UNKNOWN) label('大寶藏', sx + Tp / 2, SY(tr.y) - fs(8), 12, '#ffd24a');
    }

    // 7. 火光與各種光暈
    c.imageSmoothingEnabled = true;
    c.globalCompositeOperation = 'lighter';
    for (let y = Math.max(0, y0 - 2); y <= Math.min(H - 1, y1 + 2); y++) {
      for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x1 + 2); x++) {
        const i = y * W + x;
        if (!v.torch[i]) continue;
        // 火光用兩三段亮度跳動，比較像素風
        light('255,160,70', SX(x) + Tp / 2, SY(y) + Tp * 0.25, Tp * 2.1, 0.14 + 0.03 * (Math.floor(time * 6 + i * 1.7) % 3));
        if (!small && Math.random() < dt * 0.5) this.parts.push({ x: x + 0.5, y: y + 0.2, vx: (Math.random() - 0.5) * 0.3, vy: -0.6 - Math.random() * 0.5, g: -0.3, life: 0.8, max: 0.8, big: false, color: '#ffc13a' });
      }
    }
    for (const h of v.homes) light('255,190,110', SX(h.cx) + Tp / 2, SY(h.cy) + Tp * 0.9, Tp * 3.6, 0.2);
    for (const L of v.lasers) light('255,70,50', SX(L.x) + Tp / 2, SY(L.y) + Tp * 0.2, Tp * 0.9, 0.3 + 0.15 * (Math.floor(time * 4 + L.x) % 2));
    for (const p of v.portals) light('170,100,255', SX(p.x) + Tp / 2, SY(p.y) + Tp / 2, Tp * 1.3, 0.3);
    if (!tr.taken) light('255,205,90', SX(tr.x) + Tp / 2, SY(tr.y) + Tp / 2, Tp * 1.7, 0.3 + 0.08 * (Math.floor(time * 3) % 2));
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.imageSmoothingEnabled = small;

    // 8. 道具的作用範圍預覽、選取中礦工的路線與排隊中的目的地
    if (ui.preview && ui.preview.tiles.length) {
      const rgb = ui.preview.rgb;
      const th = Math.max(1, k);
      for (const i of ui.preview.tiles) {
        const sx = SX(i % W);
        const sy = SY((i / W) | 0);
        rect(`rgba(${rgb},.3)`, sx, sy, Tp, Tp);
        c.fillStyle = `rgba(${rgb},.75)`;
        c.fillRect(sx, sy, Tp, th);
        c.fillRect(sx, sy + Tp - th, Tp, th);
        c.fillRect(sx, sy, th, Tp);
        c.fillRect(sx + Tp - th, sy, th, Tp);
      }
    }
    const own = v.miners.filter((m) => m.team === me);
    const sel = new Set(ui.sel || []);
    const primary = own.find((m) => m.id === (ui.sel || [])[0] && m.state !== 'fountain');
    if (primary) {
      const dot = (i, color, size) => rect(color, SX(i % W) + Math.round((Tp - size) / 2), SY((i / W) | 0) + Math.round((Tp - size) / 2), size, size);
      if (primary.path) for (const p of primary.path) dot(p, 'rgba(255,226,122,.85)', Math.max(2, 2 * k));
      const stops = [];
      if (primary.path && primary.path.length) stops.push(primary.path[primary.path.length - 1]);
      for (const q of primary.queue || []) stops.push(q);
      stops.forEach((i, n) => {
        const sx = SX(i % W);
        const sy = SY((i / W) | 0);
        const pulse = (Math.floor(time * 4) % 2) * k;
        corners(sx + pulse, sy + pulse, Tp - 2 * pulse, Tp - 2 * pulse, 4 * k, Math.max(1, k), '#ffe27a');
        if (stops.length > 1 && !small) label(String(n + 1), sx + Tp / 2, sy + Tp / 2, 11, '#ffe27a');
      });
    }

    // 9. 礦工
    const shown = v.miners.filter((m) => m.state !== 'fountain');
    shown.sort((a, b) => a.y - b.y || a.id - b.id);
    for (const m of shown) {
      const p = this.minerPos(m, m.frozen > 0 ? 0 : alpha);
      const sx = Math.round((p.x * Tp) / k) * k - cx;
      const sy = Math.round((p.y * Tp) / k) * k - cy;
      const a = m.act;
      const pose = a && a.kind === 'walk' ? 'walk' : a && a.kind === 'dig' ? 'dig' : 'idle';
      const frame = m.frozen > 0 ? 0 : pose === 'walk' ? Math.floor(time * 8 + m.id) % 2 : pose === 'dig' ? Math.floor(time * 6 + m.id) % 2 : 0;
      let dx = m.dx;
      if (a && a.to >= 0 && (a.to % W) !== m.x) dx = (a.to % W) - m.x;
      const mine = m.team === me;
      if (small) {
        const r = Math.max(3 * dpr, Tp * 0.42);
        c.fillStyle = TEAM[m.team].main;
        c.strokeStyle = sel.has(m.id) ? '#ffe27a' : '#ffffff';
        c.lineWidth = Math.max(1.5, 1.5 * dpr);
        c.beginPath();
        c.arc(sx + Tp / 2, sy + Tp / 2, r, 0, TAU);
        c.fill();
        c.stroke();
        if (m.carry === 'bomb') img(sp.bombSmall(), sx, sy - Tp, Math.max(1, Math.round(dpr)));
        continue;
      }
      // 挖掘時噴出的土屑
      if (pose === 'dig' && a.to >= 0 && Math.random() < dt * 22) {
        const tx = a.to % W;
        const ty = (a.to / W) | 0;
        const cols = DUST[know[a.to]] || DUST[T.DIRT];
        this.parts.push({
          x: m.x + 0.5 + (tx - m.x) * 0.55 + (Math.random() - 0.5) * 0.3,
          y: m.y + 0.5 + (ty - m.y) * 0.55 + (Math.random() - 0.5) * 0.3,
          vx: (m.x - tx) * 1.5 + (Math.random() - 0.5) * 2,
          vy: (m.y - ty) * 1.5 - 1 - Math.random() * 1.5,
          g: 7,
          life: 0.5,
          max: 0.5,
          big: Math.random() < 0.3,
          color: cols[Math.floor(Math.random() * cols.length)],
        });
      }
      const bob = pose === 'walk' ? frame * k : 0;
      const top = sy - 2 * k - bob; // 圖的上緣
      if (sel.has(m.id)) {
        const pulse = (Math.floor(time * 3) % 2) * k;
        corners(sx - k - pulse, sy - 3 * k - pulse, Tp + 2 * k + 2 * pulse, Tp + 3 * k + 2 * pulse, 4 * k, k, m.id === (ui.sel || [])[0] ? '#ffe27a' : '#fff3b0');
      }
      if (a && a.kind === 'teleport') c.globalAlpha = Math.floor(time * 12) % 2 ? 0.35 : 0.8;
      img(sp.miner(m.team, v.chars[m.team], pose, frame, dx < 0), sx, top);
      c.globalAlpha = 1;
      if (m.frozen > 0) {
        rect('rgba(159,227,255,.5)', sx + 2 * k, top + k, 12 * k, 14 * k);
        rect('#ffffff', sx + 4 * k, top + 3 * k, k, 2 * k);
        rect('#ffffff', sx + 10 * k, top + 7 * k, k, 2 * k);
      }
      if (a && (a.kind === 'torch' || a.kind === 'use')) bar(sx + 2 * k, sy + Tp - k, Tp - 4 * k, 1 - a.left / a.total, '#ffb347');
      // 血量
      const pw = 2 * k;
      const total = m.maxHp * (pw + k) - k;
      const bx = sx + Math.round((Tp - total) / (2 * k)) * k;
      const by = top - 3 * k;
      rect(INK, bx - k, by - k, total + 2 * k, pw + 2 * k);
      for (let q = 0; q < m.maxHp; q++) rect(q < m.hp ? (mine ? '#6fe06f' : '#ff8a80') : '#3a3a3a', bx + q * (pw + k), by, pw, pw);
      for (let q = 1; q < m.level; q++) rect('#ffd24a', bx + total + k + (q - 1) * 3 * k, by, 2 * k, 2 * k);
      if (mine) {
        // 編號
        const n = own.indexOf(m) + 1;
        const bs = Math.max(5 * k, fs(11));
        const nx = sx - 2 * k;
        const ny = top - k;
        rect(INK, nx - k, ny - k, bs + 2 * k, bs + 2 * k);
        rect(TEAM[me].main, nx, ny, bs, bs);
        c.font = `700 ${Math.round(bs * 0.9)}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = '#ffffff';
        c.fillText(String(n), nx + bs / 2, ny + bs / 2 + 1);
        if (m.auto) label('自動', sx + Tp / 2, sy + Tp + fs(5), 9, '#8fe08a');
        else if (!a && !m.task && !m.frozen && !isCapturing(v, m) && Math.floor(time * 2) % 2) img(sp.zzz(), sx + 11 * k, top - 8 * k);
      }
      if (m.carry === 'bomb') {
        img(sp.bombSmall(), sx + 9 * k, top - 9 * k + (Math.floor(time * 4) % 2) * k);
      } else if (m.carry && mine) {
        const ik = Math.max(1, Math.floor(k / 2));
        const ix = sx + 11 * k;
        const iy = top - 2 * k - 16 * ik;
        rect(INK, ix - ik, iy - ik, 18 * ik, 18 * ik);
        rect('#2c211a', ix, iy, 16 * ik, 16 * ik);
        c.drawImage(sp.icon(m.carry), ix, iy, 16 * ik, 16 * ik);
      }
    }
    // 泉水蹲的礦工：在自己家上方顯示復活倒數
    if (myHome && !small) {
      let row = 0;
      own.forEach((m, q) => {
        if (m.state !== 'fountain') return;
        label(`💤 ${q + 1} 號 ${Math.ceil(m.respawn / 10)} 秒`, SX(myHome.cx) + Tp / 2, SY(myHome.cy - 1) - fs(12 + row * 15), 12, '#cfd6e6');
        row++;
      });
    }

    // 10. 粒子與特效
    for (let q = this.parts.length - 1; q >= 0; q--) {
      const p = this.parts[q];
      p.life -= dt;
      if (p.life <= 0) {
        this.parts.splice(q, 1);
        continue;
      }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const sx = Math.round((p.x * Tp) / k) * k - cx;
      const sy = Math.round((p.y * Tp) / k) * k - cy;
      if (sx < -10 || sy < -10 || sx > this.dw + 10 || sy > this.dh + 10) continue;
      c.globalAlpha = p.life / p.max > 0.35 ? 1 : 0.5;
      const size = (p.big ? 2 : 1) * k;
      rect(p.color, sx, sy, size, size);
    }
    c.globalAlpha = 1;
    this.fx = this.fx.filter((f) => time - f.t0 < (FX_DUR[f.kind] || 0.5));
    for (const f of this.fx) {
      const dur = FX_DUR[f.kind] || 0.5;
      const p = (time - f.t0) / dur;
      const fx = SX(f.x) + Tp / 2;
      const fy = SY(f.y) + Tp / 2;
      c.globalAlpha = p < 0.6 ? 1 : 0.55;
      if (f.kind === 'laser') {
        // 用方塊排成的光束
        const tx = SX(f.x2) + Tp / 2;
        const ty = SY(f.y2) + Tp / 2;
        const sy0 = fy - Tp * 0.25;
        const n = Math.max(1, Math.round(Math.hypot(tx - fx, ty - sy0) / k));
        for (let q = 0; q <= n; q++) {
          const bx = Math.round((fx + ((tx - fx) * q) / n) / k) * k;
          const by = Math.round((sy0 + ((ty - sy0) * q) / n) / k) * k;
          rect('#e23b33', bx - k, by - k, 3 * k, 3 * k);
          rect('#fff3ee', bx, by, k, k);
        }
      } else if (f.kind === 'boom') {
        const R = Tp * (f.big ? 4.2 : 2.8);
        c.imageSmoothingEnabled = true;
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = Math.max(0, 1 - p * 1.4);
        c.drawImage(sp.glow('255,170,70'), fx - R, fy - R, R * 2, R * 2);
        c.globalCompositeOperation = 'source-over';
        c.imageSmoothingEnabled = small;
        c.globalAlpha = p < 0.6 ? 1 : 0.5;
        ring(fx, fy, R * (0.15 + 0.85 * Math.sqrt(p)), '#fff3b0', 2 * k);
      } else if (f.kind === 'death') {
        if (small) label('💀', fx, fy - p * Tp, 12, '#ffffff');
        else img(sp.skull(), fx - 4 * k, Math.round((fy - 4 * k - p * Tp * 0.9) / k) * k);
      } else if (f.kind === 'freeze' || f.kind === 'snuff' || f.kind === 'capture' || f.kind === 'order' || f.kind === 'alert') {
        const color = { freeze: '#9fe3ff', snuff: '#999999', capture: '#ffe27a', order: '#ffe27a', alert: '#ff4040' }[f.kind];
        const R = { freeze: 4, snuff: 4, capture: 1.5, order: 0.6, alert: 2.2 }[f.kind];
        const pp = f.kind === 'alert' ? (p * 3) % 1 : p;
        ring(fx, fy, Tp * R * (0.15 + 0.85 * pp), color, f.kind === 'order' ? k : 2 * k);
      } else if (f.kind === 'coin') {
        label(`+$${f.amount}`, fx, fy - Tp * 0.3 - p * Tp * 0.9, 13, '#ffd24a');
      }
    }
    c.globalAlpha = 1;

    // 11. 游標、地圖邊框、畫面四周的暗角
    if (ui.hover && ui.hover.x >= 0 && ui.hover.y >= 0 && ui.hover.x < W && ui.hover.y < H) {
      corners(SX(ui.hover.x), SY(ui.hover.y), Tp, Tp, Math.max(2, Math.round(Tp / 4)), Math.max(1, k), 'rgba(255,255,255,.85)');
    }
    const bw = Math.max(2, 2 * k);
    c.fillStyle = '#5a4636';
    c.fillRect(SX(0) - bw, SY(0) - bw, W * Tp + 2 * bw, bw);
    c.fillRect(SX(0) - bw, SY(H), W * Tp + 2 * bw, bw);
    c.fillRect(SX(0) - bw, SY(0), bw, H * Tp);
    c.fillRect(SX(W), SY(0), bw, H * Tp);
    const vc = this.viewCenter;
    const vr = Math.hypot(this.dw, this.dh) / 2;
    const vg = c.createRadialGradient(vc.x, vc.y, vr * 0.45, vc.x, vc.y, vr);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.45)');
    c.fillStyle = vg;
    c.fillRect(0, 0, this.dw, this.dh);
  }
}
