// 把 pixels.js 的像素圖資料變成可以畫的圖，並快取起來。
// 遊戲畫面一律用整數倍、不做平滑地放大這些圖，所以每個像素都是清楚的方塊。
import * as px from './pixels.js';

export { TEAM } from './pixels.js';

function bake(p) {
  const c = document.createElement('canvas');
  c.width = p.w;
  c.height = p.h;
  const x = c.getContext('2d');
  for (let j = 0; j < p.h; j++) {
    for (let i = 0; i < p.w; i++) {
      const col = p.d[j * p.w + i];
      if (!col) continue;
      x.fillStyle = col;
      x.fillRect(i, j, 1, 1);
    }
  }
  return c;
}

export class Sprites {
  constructor() {
    this.cache = new Map();
    this.glows = new Map();
    this.urls = new Map();
    this.set = null;
  }

  get(key, make) {
    let c = this.cache.get(key);
    if (!c) {
      c = bake(make());
      this.cache.set(key, c);
    }
    return c;
  }

  // 有顏色的柔光（rgb 是 "r,g,b" 字串），用來做火光
  glow(rgb) {
    let c = this.glows.get(rgb);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = 128;
      const x = c.getContext('2d');
      const gr = x.createRadialGradient(64, 64, 2, 64, 64, 64);
      gr.addColorStop(0, `rgba(${rgb},1)`);
      gr.addColorStop(0.4, `rgba(${rgb},.42)`);
      gr.addColorStop(1, `rgba(${rgb},0)`);
      x.fillStyle = gr;
      x.fillRect(0, 0, 128, 128);
      this.glows.set(rgb, c);
    }
    return c;
  }

  // 地形材質與裝飾（只建一次）
  tiles() {
    if (this.set) return this.set;
    const many = (n, seed, fn) => Array.from({ length: n }, (_, k) => bake(fn(seed + k * 7919)));
    const decor = {};
    for (const name of px.DECOR_NAMES) decor[name] = bake(px.decorPix(name));
    this.set = {
      dirt: many(8, 11, px.dirtPix),
      hard: many(5, 211, px.hardPix),
      rock: many(5, 307, px.rockPix),
      floor: many(6, 401, px.floorPix),
      unknown: many(3, 503, px.unknownPix),
      ore: many(4, 601, px.orePix),
      mud: many(3, 701, px.mudPix),
      face: [0, 1, 2].map((kind) => many(4, 900 + kind * 31, (s) => px.facePix(kind, s))),
      support: bake(px.supportPix()),
      decor,
    };
    return this.set;
  }

  miner(team, char, pose, frame, flip) {
    return this.get(`m${team}${char}${pose}${frame}${flip ? 'L' : 'R'}`, () => {
      const p = px.minerPix(team, char, pose, frame);
      return flip ? p.flip() : p;
    });
  }
  home(team) {
    return this.get(`home${team}`, () => px.homePix(team));
  }
  mine() {
    return this.get('mine', px.minePix);
  }
  chest() {
    return this.get('chest', px.chestPix);
  }
  laser(team) {
    return this.get(`laser${team}`, () => px.laserPix(team));
  }
  spike() {
    return this.get('spike', px.spikePix);
  }
  torch(team, frame) {
    return this.get(`torch${team}${frame}`, () => px.torchPix(team, frame));
  }
  portal(frame) {
    return this.get(`portal${frame}`, () => px.portalPix(frame));
  }
  flag(team, frame) {
    return this.get(`flag${team}${frame}`, () => px.flagPix(team, frame));
  }
  skull() {
    return this.get('skull', px.skullPix);
  }
  bombSmall() {
    return this.get('bombS', px.bombSmallPix);
  }
  zzz() {
    return this.get('zzz', px.zzzPix);
  }
  icon(id) {
    return this.get(`icon${id}`, () => px.iconPix(id));
  }

  // ---------- 給 HTML 介面用的圖（整數倍放大後轉成網址） ----------

  url(key, canvas, scale) {
    const k = `${key}@${scale}`;
    let u = this.urls.get(k);
    if (!u) {
      const c = document.createElement('canvas');
      c.width = canvas.width * scale;
      c.height = canvas.height * scale;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(canvas, 0, 0, c.width, c.height);
      u = c.toDataURL();
      this.urls.set(k, u);
    }
    return u;
  }

  avatar(team, char, scale = 4) {
    return this.url(`av${team}${char}`, this.miner(team, char, 'idle', 0, false), scale);
  }

  iconUrl(id, scale = 3) {
    return this.url(`ic${id}`, this.icon(id), scale);
  }
}
