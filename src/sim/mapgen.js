// 地圖生成：50×50 的地下礦區。兩個家各在一側但位置隨機，礦井與大寶藏到兩個家的距離差不多。
import { W, H, N, T, idx, inb } from './constants.js';
import { mulberry32 } from './rng.js';

const ri = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const man = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);
const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

export function generateMap(seed) {
  for (let k = 0; k < 60; k++) {
    const m = attempt(mulberry32((seed + k * 7919) >>> 0));
    if (m) return m;
  }
  throw new Error('地圖生成失敗');
}

function attempt(r) {
  const tiles = new Uint8Array(N); // 預設全是土
  const ore = new Uint8Array(N);
  const h0 = { x: ri(r, 5, 11), y: ri(r, 6, 43) };
  const h1 = { x: ri(r, 38, 44), y: ri(r, 6, 43) };
  const d0 = (x, y) => man(x, y, h0.x, h0.y);
  const d1 = (x, y) => man(x, y, h1.x, h1.y);
  const feats = [];
  const far = (x, y, d) => feats.every((f) => man(x, y, f.x, f.y) >= d);
  const pick = (pred, lo = 2, hi = 47) => {
    const c = [];
    for (let y = lo; y <= hi; y++) for (let x = lo; x <= hi; x++) if (pred(x, y)) c.push({ x, y });
    return c.length ? c[ri(r, 0, c.length - 1)] : null;
  };

  // 大寶藏：在兩個家的正中間一帶
  let best = Infinity;
  for (let y = 3; y <= 46; y++)
    for (let x = 3; x <= 46; x++)
      if (Math.abs(d0(x, y) - d1(x, y)) <= 1) best = Math.min(best, d0(x, y) + d1(x, y));
  const treasure = pick((x, y) => Math.abs(d0(x, y) - d1(x, y)) <= 1 && d0(x, y) + d1(x, y) <= best + 2, 3, 46);
  if (!treasure) return null;
  feats.push(treasure);

  // 一般礦井：兩邊各一座，離自己家一樣遠
  const dm = ri(r, 5, 7);
  const m0 = pick((x, y) => d0(x, y) === dm && cheb(x, y, h0.x, h0.y) >= 3 && d1(x, y) > dm + 8 && far(x, y, 6));
  const m1 = pick((x, y) => d1(x, y) === dm && cheb(x, y, h1.x, h1.y) >= 3 && d0(x, y) > dm + 8 && far(x, y, 6));
  if (!m0 || !m1) return null;
  feats.push(m0, m1);

  // 中立礦井：三座，到兩個家的距離差不超過 2
  const neutrals = [];
  for (let k = 0; k < 3; k++) {
    let p = null;
    for (const gap of [12, 9, 6]) {
      p = pick((x, y) => Math.abs(d0(x, y) - d1(x, y)) <= 2 && d0(x, y) >= 12 && far(x, y, gap));
      if (p) break;
    }
    if (!p) return null;
    neutrals.push(p);
    feats.push(p);
  }

  const reserved = (x, y) =>
    cheb(x, y, h0.x, h0.y) <= 3 ||
    cheb(x, y, h1.x, h1.y) <= 3 ||
    cheb(x, y, treasure.x, treasure.y) <= 2 ||
    feats.some((f) => cheb(x, y, f.x, f.y) <= 1);

  // 帶狀石頭：不能挖
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const bands = ri(r, 8, 10);
  for (let b = 0; b < bands; b++) {
    let x = ri(r, 2, 47);
    let y = ri(r, 2, 47);
    const [dx, dy] = dirs[ri(r, 0, 3)];
    const len = ri(r, 7, 15);
    const thick = r() < 0.4 ? 2 : 1;
    for (let s = 0; s < len; s++) {
      for (let t = 0; t < thick; t++) {
        const xx = dx === 0 ? x + t : x;
        const yy = dx === 0 ? y : y + t;
        if (inb(xx, yy) && !reserved(xx, yy)) tiles[idx(xx, yy)] = T.ROCK;
      }
      x += dx;
      y += dy;
      if (r() < 0.25) {
        if (dx === 0) x += r() < 0.5 ? 1 : -1;
        else y += r() < 0.5 ? 1 : -1;
      }
    }
  }

  // 洞穴：一開始就挖空的空間，讓地圖像真正的地下礦井
  const caves = ri(r, 7, 9);
  for (let c = 0; c < caves; c++) {
    let x = ri(r, 3, 46);
    let y = ri(r, 3, 46);
    const steps = ri(r, 14, 26);
    for (let s = 0; s < steps; s++) {
      for (const [ox, oy] of [[0, 0], [r() < 0.5 ? 1 : -1, 0], [0, r() < 0.5 ? 1 : -1]]) {
        const xx = x + ox;
        const yy = y + oy;
        if (xx < 1 || yy < 1 || xx > W - 2 || yy > H - 2) continue;
        if (cheb(xx, yy, h0.x, h0.y) <= 5 || cheb(xx, yy, h1.x, h1.y) <= 5) continue;
        if (tiles[idx(xx, yy)] === T.ROCK) continue;
        tiles[idx(xx, yy)] = T.FLOOR;
      }
      const [mx, my] = [[1, 0], [-1, 0], [0, 1], [0, -1]][ri(r, 0, 3)];
      x = Math.min(W - 3, Math.max(2, x + mx));
      y = Math.min(H - 3, Math.max(2, y + my));
    }
  }

  // 家、礦井、大寶藏的空間
  for (const h of [h0, h1]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles[idx(h.x + dx, h.y + dy)] = T.FLOOR;
  for (const m of [m0, m1, ...neutrals]) tiles[idx(m.x, m.y)] = T.FLOOR;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles[idx(treasure.x + dx, treasure.y + dy)] = T.FLOOR;

  // 金礦脈：挖到比較值錢
  for (let v = 0; v < 46; v++) {
    let x = ri(r, 1, W - 2);
    let y = ri(r, 1, H - 2);
    const size = ri(r, 1, 3);
    for (let s = 0; s < size; s++) {
      if (inb(x, y) && tiles[idx(x, y)] === T.DIRT) ore[idx(x, y)] = 1;
      const [mx, my] = [[1, 0], [-1, 0], [0, 1], [0, -1]][ri(r, 0, 3)];
      x += mx;
      y += my;
    }
  }

  // 確認所有重點都互相到得了（不被石頭完全封死）
  const seen = new Uint8Array(N);
  const stack = [idx(h0.x, h0.y)];
  seen[stack[0]] = 1;
  while (stack.length) {
    const u = stack.pop();
    const ux = u % W;
    const uy = (u / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const vx = ux + dx;
      const vy = uy + dy;
      if (!inb(vx, vy)) continue;
      const v = idx(vx, vy);
      if (seen[v] || tiles[v] === T.ROCK) continue;
      seen[v] = 1;
      stack.push(v);
    }
  }
  for (const p of [h1, treasure, m0, m1, ...neutrals]) if (!seen[idx(p.x, p.y)]) return null;

  return {
    tiles,
    ore,
    homes: [
      { team: 0, cx: h0.x, cy: h0.y },
      { team: 1, cx: h1.x, cy: h1.y },
    ],
    mines: [
      { x: m0.x, y: m0.y, owner: 0, neutral: false },
      { x: m1.x, y: m1.y, owner: 1, neutral: false },
      ...neutrals.map((p) => ({ x: p.x, y: p.y, owner: -1, neutral: true })),
    ],
    treasure: { x: treasure.x, y: treasure.y },
  };
}
