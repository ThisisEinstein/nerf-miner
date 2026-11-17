// 玩家視角：把完整的遊戲狀態濾成「某一隊看得到或記得的東西」。
// 畫面與 UI 只讀這個視角，不直接讀 Game——單機和連線走同一條路，
// 連線時伺服器也只把這份資料送給玩家，所以對手的家、陷阱、錢都不會外流。
import { N, idx, inb, UNKNOWN } from './constants.js';

// 所有格狀資料都是長度 N 的 Uint8Array
export const GRIDS = ['know', 'ore', 'vis', 'lit', 'torch', 'mud'];

export function makeView(g, team) {
  const tm = g.teams[team];
  const vis = tm.visible;
  const know = tm.know;

  // 火把與泥地：自己的永遠知道，敵方的只有看得到的時候才知道（存成 隊伍+1，0 表示沒有）
  const torch = new Uint8Array(N);
  const mud = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = g.torch[i];
    if (t >= 0 && (t === team || vis[i])) torch[i] = t + 1;
    const m = g.mud[i];
    if (m >= 0 && (m === team || vis[i])) mud[i] = m + 1;
  }

  const miners = [];
  for (const m of g.miners) {
    const own = m.team === team;
    if (!own && (m.state === 'fountain' || !vis[idx(m.x, m.y)])) continue;
    const a = m.act;
    const o = {
      id: m.id,
      team: m.team,
      x: m.x,
      y: m.y,
      level: m.level,
      hp: m.hp,
      maxHp: g.maxHp(m),
      frozen: m.frozen > 0 ? m.frozen : 0,
      dx: m.dir[0],
      state: own ? m.state : 'idle',
      act: a ? { kind: a.kind, to: a.to ?? -1, left: a.left, total: a.total } : null,
      // 敵方手上拿什麼看不出來，只有炸彈藏不住
      carry: own ? m.carry : m.carry === 'bomb' ? 'bomb' : null,
    };
    if (own) {
      o.n = m.n;
      o.respawn = m.respawn;
      o.buffs = m.buffs;
      o.task = m.task ? 1 : 0;
      o.eta = m.eta;
      o.path = m.path ? Array.from(m.path) : null;
      o.invested = m.invested;
      o.auto = m.auto ? 1 : 0;
      o.queue = m.queue.map((q) => idx(q.x, q.y));
      // 正要回家拿的道具（介面用它來讓玩家先選好要放在哪）
      o.fetch = m.task && m.task.type === 'pickup' ? m.task.item : null;
    }
    miners.push(o);
  }

  const homes = [];
  g.homes.forEach((h, k) => {
    if (h.dead) return;
    const own = h.team === team;
    if (!own && !tm.seenHomes.has(k)) return;
    // 敵方的家是真是假看不出來；sure 表示已經靠精確情報確認是真的
    homes.push({ id: k, team: h.team, cx: h.cx, cy: h.cy, fake: own && h.fake, sure: !own && tm.confirmedHome === k });
  });

  const mines = [];
  for (const mn of g.mines) {
    if (!tm.knownMines.has(mn.id)) continue;
    const seen = vis[idx(mn.x, mn.y)] === 1;
    mines.push({
      id: mn.id,
      x: mn.x,
      y: mn.y,
      neutral: mn.neutral,
      owner: tm.mineSeen[mn.id] ?? -1,
      prog: seen ? mn.prog : 0,
      progTeam: seen ? mn.progTeam : -1,
    });
  }

  const tr = g.treasure;
  const trSeen = vis[idx(tr.x, tr.y)] === 1;
  const treasure = { x: tr.x, y: tr.y, taken: tr.taken, prog: trSeen ? tr.prog : 0, progTeam: trSeen ? tr.progTeam : -1 };

  const lasers = [];
  for (const L of g.lasers) {
    if (L.team === team || (L.revealed && know[idx(L.x, L.y)] !== UNKNOWN)) lasers.push({ team: L.team, x: L.x, y: L.y });
  }
  const spikes = [];
  for (const s of g.spikes) if (s.team === team) spikes.push({ x: s.x, y: s.y });
  const portals = [];
  for (const p of g.portals) if (p.team === team || vis[idx(p.x, p.y)]) portals.push({ team: p.team, x: p.x, y: p.y });

  const events = [];
  for (const e of g.events) {
    if (e.type === 'msg') {
      if (e.to === team || e.to === -1) events.push({ type: 'msg', text: e.text, kind: e.kind, x: e.x, y: e.y });
    } else if (e.type === 'fx') {
      if (e.kind === 'coin' && e.team !== team) continue;
      if (e.team === team || e.big || (inb(e.x, e.y) && vis[idx(e.x, e.y)])) events.push(e);
    } else {
      events.push(e); // announce / vision / emote / taunt：兩邊都收得到
    }
  }

  // 概略情報的範圍一直顯示到確認敵方真正的家為止（看到的家可能是假的，所以不能一看到就收起來）
  const showZone = tm.intelZone && tm.confirmedHome < 0;
  return {
    tick: g.tick,
    me: team,
    over: g.over ? { ...g.over, stats: g.teams.map((t) => ({ ...t.stats })) } : null,
    money: tm.money,
    stock: tm.stock.slice(),
    litCount: tm.litCount,
    dug: tm.stats.dug,
    // 視野佔比要到 4 分鐘公告後才看得到
    share: g.visionAnnounced ? g.share(team) : null,
    priceMul: tm.mod.price,
    chars: g.chars,
    know,
    ore: tm.knowOre,
    vis,
    lit: tm.lit,
    torch,
    mud,
    homes,
    mines,
    treasure,
    lasers,
    spikes,
    portals,
    miners,
    intelZone: showZone ? tm.intelZone : null,
    events,
  };
}

// ---------- 連線用的編碼：格狀資料只送有變的格子 ----------

function rle(a) {
  const out = [];
  let v = a[0];
  let n = 1;
  for (let i = 1; i < a.length; i++) {
    if (a[i] === v) n++;
    else {
      out.push(v, n);
      v = a[i];
      n = 1;
    }
  }
  out.push(v, n);
  return out;
}

function unrle(r, a) {
  let i = 0;
  for (let k = 0; k + 1 < r.length && i < a.length; k += 2) {
    const end = Math.min(a.length, i + r[k + 1]);
    a.fill(r[k], i, end);
    i = end;
  }
}

// 伺服器端：每個連線一個。第一次（或 reset 之後）送整張，之後只送差異。
export class ViewEncoder {
  constructor() {
    this.last = null;
  }

  reset() {
    this.last = null;
  }

  encode(view) {
    const out = {};
    for (const k in view) if (!GRIDS.includes(k)) out[k] = view[k];
    const g = {};
    const first = !this.last;
    if (first) this.last = {};
    for (const k of GRIDS) {
      const cur = view[k];
      if (first) {
        this.last[k] = Uint8Array.from(cur);
        g[k] = { f: rle(cur) };
        continue;
      }
      const prev = this.last[k];
      const d = [];
      for (let i = 0; i < N; i++) {
        if (cur[i] !== prev[i]) {
          d.push(i, cur[i]);
          prev[i] = cur[i];
        }
      }
      if (d.length) g[k] = d.length > N ? { f: rle(cur) } : { d };
    }
    out.g = g;
    return out;
  }
}

// 玩家端：把伺服器送來的差異套回完整的格狀資料。
export class ViewDecoder {
  constructor() {
    this.grids = {};
    for (const k of GRIDS) this.grids[k] = new Uint8Array(N);
  }

  decode(msg) {
    const { g, ...rest } = msg;
    for (const k of GRIDS) {
      const e = g && g[k];
      if (!e) continue;
      const a = this.grids[k];
      if (e.f) unrle(e.f, a);
      else for (let j = 0; j + 1 < e.d.length; j += 2) a[e.d[j]] = e.d[j + 1];
    }
    return { ...rest, ...this.grids };
  }
}
