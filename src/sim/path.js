// 格子地圖上的最短路徑（Dijkstra）。cost(i) 回傳「走進第 i 格」要花的時間，Infinity 表示不能進。
import { W, H, N } from './constants.js';

const dist = new Float64Array(N);
const prev = new Int32Array(N);
const done = new Uint8Array(N);
const CAP = N * 5 + 64;
const hk = new Float64Array(CAP);
const hn = new Int32Array(CAP);
let hs = 0;

function push(k, n) {
  let i = hs++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hk[p] <= k) break;
    hk[i] = hk[p];
    hn[i] = hn[p];
    i = p;
  }
  hk[i] = k;
  hn[i] = n;
}

function pop() {
  const top = hn[0];
  hs--;
  const k = hk[hs];
  const n = hn[hs];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= hs) break;
    if (c + 1 < hs && hk[c + 1] < hk[c]) c++;
    if (hk[c] >= k) break;
    hk[i] = hk[c];
    hn[i] = hn[c];
    i = c;
  }
  hk[i] = k;
  hn[i] = n;
  return top;
}

/**
 * @param {number} start 起點格
 * @param {number} goal 終點格
 * @param {(i:number)=>number} cost 走進該格的花費
 * @param {Map<number,{to:number,cost:number}[]>|null} edges 額外的邊（傳送門）
 * @param {number[]|null} alts 終點進不去時的替代終點（預設是終點的上下左右）
 * @returns {{path:number[], cost:number, reached:boolean}|null}
 *   path 不含起點。終點進不去時，改走到最近的替代終點（reached=false）。
 */
export function dijkstra(start, goal, cost, edges = null, alts = null) {
  dist.fill(Infinity);
  done.fill(0);
  hs = 0;
  dist[start] = 0;
  prev[start] = -1;
  push(0, start);

  const relax = (u, v, d) => {
    if (done[v]) return;
    const c = cost(v);
    if (c === Infinity) return;
    const nd = d + c;
    if (nd < dist[v]) {
      dist[v] = nd;
      prev[v] = u;
      push(nd, v);
    }
  };

  while (hs > 0) {
    const d = hk[0];
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === goal) break;
    const ux = u % W;
    const uy = (u / W) | 0;
    if (ux > 0) relax(u, u - 1, d);
    if (ux < W - 1) relax(u, u + 1, d);
    if (uy > 0) relax(u, u - W, d);
    if (uy < H - 1) relax(u, u + W, d);
    const ex = edges && edges.get(u);
    if (ex) {
      for (const e of ex) {
        if (done[e.to]) continue;
        const nd = d + e.cost;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
          push(nd, e.to);
        }
      }
    }
  }

  let end = goal;
  if (!done[goal]) {
    const gx = goal % W;
    const gy = (goal / W) | 0;
    let best = -1;
    let bd = Infinity;
    const tryN = (v) => {
      if (dist[v] < bd) {
        bd = dist[v];
        best = v;
      }
    };
    if (alts) {
      for (const v of alts) tryN(v);
    } else {
      if (gx > 0) tryN(goal - 1);
      if (gx < W - 1) tryN(goal + 1);
      if (gy > 0) tryN(goal - W);
      if (gy < H - 1) tryN(goal + W);
    }
    if (best < 0) return null;
    end = best;
  }

  const path = [];
  for (let v = end; v !== start && v >= 0; v = prev[v]) path.push(v);
  path.reverse();
  return { path, cost: dist[end], reached: end === goal };
}
