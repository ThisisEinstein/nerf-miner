// Nerf Miner 的遊戲模擬核心。不碰畫面：輸入是指令（command），輸出是狀態與事件（events）。
// 這樣同一份程式可以在瀏覽器、測試、以及之後的連線伺服器上跑。
import { W, H, N, T, C, TPS, MATCH_TICKS, UNKNOWN, idx, inb } from './constants.js';
import { ITEMS, priceOf } from './items.js';
import { charMod } from './chars.js';
import { generateMap } from './mapgen.js';
import { dijkstra } from './path.js';
import { mulberry32 } from './rng.js';

const man = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);
const isWall = (t) => t === T.DIRT || t === T.HARD;
const CAUSE = { melee: '被打倒了', laser: '被激光打回家', spike: '踩到尖刺', tnt: '被 TNT 炸到' };

function diamond(arr, cx, cy, r) {
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    const w = r - Math.abs(dy);
    for (let dx = -w; dx <= w; dx++) {
      const x = cx + dx;
      if (x >= 0 && x < W) arr[y * W + x] = 1;
    }
  }
}

export class Game {
  // opts.chars：兩隊選的角色代號（見 chars.js），沒給就沒有角色加成
  constructor(seed = Date.now() >>> 0, opts = {}) {
    this.seed = seed >>> 0;
    this.chars = [opts.chars?.[0] ?? null, opts.chars?.[1] ?? null];
    this.rng = mulberry32(this.seed ^ 0x5bd1e995);
    const map = generateMap(this.seed);
    this.tiles = map.tiles;
    this.ore = map.ore;
    this.torch = new Int8Array(N).fill(-1); // 每格的火把屬於哪一隊，-1 表示沒有
    this.mud = new Int8Array(N).fill(-1);
    this.homeAt = new Int16Array(N).fill(-1);
    this.mineAt = new Int16Array(N).fill(-1);
    this.litDirty = [true, true];
    // homes[0]、homes[1] 是兩隊真正的家，之後加進來的都是假的家
    this.homes = map.homes.map((h) => ({ team: h.team, cx: h.cx, cy: h.cy, fake: false, dead: false }));
    this.homes.forEach((_, k) => this.stampHome(k));
    this.mines = map.mines.map((m, id) => ({ id, x: m.x, y: m.y, owner: m.owner, neutral: m.neutral, prog: 0, progTeam: -1 }));
    for (const m of this.mines) this.mineAt[idx(m.x, m.y)] = m.id;
    this.treasure = { x: map.treasure.x, y: map.treasure.y, taken: false, prog: 0, progTeam: -1 };
    this.lasers = [];
    this.spikes = [];
    this.portals = [];
    this.miners = [];
    this.nextId = 1;
    this.events = [];
    this.queue = [];
    this.tick = 0;
    this.over = null;
    this.visionAnnounced = false;
    this.teams = [this.makeTeam(0), this.makeTeam(1)];
    for (const tm of this.teams) {
      for (let k = 0; k < C.startMiners; k++) this.spawnMiner(tm.id);
      // 中立礦井的位置開局就公開，自己那一座當然也知道；
      // 對手開局自帶的那一座離他的家很近，公開了等於洩漏家的位置，所以要親眼看到才知道
      for (const m of this.mines) {
        if (!m.neutral && m.owner !== tm.id) continue;
        tm.knownMines.add(m.id);
        tm.know[idx(m.x, m.y)] = T.FLOOR;
        if (m.owner === tm.id) tm.mineSeen[m.id] = m.owner;
      }
    }
    this.updateVision();
  }

  // ---------- 基本資料 ----------

  makeTeam(id) {
    return {
      id,
      mod: charMod(this.chars[id]), // 角色加成
      money: C.startMoney,
      stock: ['bomb'], // 家裡的庫存，開局有一顆炸彈
      lit: new Uint8Array(N), // 火把與家照亮的格子（持續視野）
      litCount: 0,
      visible: new Uint8Array(N), // 這一刻看得到的格子
      know: new Uint8Array(N).fill(UNKNOWN), // 看過的地形（迷霧記憶）
      knowOre: new Uint8Array(N),
      knownMines: new Set(),
      mineSeen: {}, // 每座礦井「最後一次看到時」屬於誰
      seenHomes: new Set(), // 看過的敵方的家（可能包含假的）
      confirmedHome: -1, // 靠精確情報確認的敵方真家
      intelZone: null,
      pings: [],
      alertUntil: 0,
      bombAlertUntil: 0,
      minerSeq: 0,
      stats: { dug: 0, kills: 0, deaths: 0, spent: 0, mines: 0 },
    };
  }

  stampHome(k) {
    const h = this.homes[k];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = idx(h.cx + dx, h.cy + dy);
        this.tiles[i] = T.FLOOR;
        this.ore[i] = 0;
        this.mud[i] = -1;
        if (this.torch[i] >= 0) {
          this.litDirty[this.torch[i]] = true;
          this.torch[i] = -1;
        }
        this.homeAt[i] = k;
      }
    }
  }

  spawnMiner(team) {
    const hm = this.homes[team];
    const tm = this.teams[team];
    const k = this.minersOf(team).length;
    const off = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]][k % 5];
    const m = {
      id: this.nextId++,
      team,
      n: ++tm.minerSeq,
      x: hm.cx + off[0],
      y: hm.cy + off[1],
      level: 1,
      hp: C.hp[0] + tm.mod.hp,
      state: 'idle', // 'idle' | 'fountain'
      act: null, // 正在做的單一步動作
      task: null, // 玩家指派的任務
      carry: null,
      buffs: { vision: 0, speed: 1, dig: 1 },
      frozen: 0,
      respawn: 0,
      dir: [team === 0 ? 1 : -1, 0],
      atkCd: 0,
      useQueued: false,
      queue: [], // 排在目前任務後面的任務
      auto: false, // 自動探索：沒事做的時候自己找地方挖
      autoAt: 0,
      path: null,
      eta: 0,
      invested: 0,
    };
    this.miners.push(m);
    return m;
  }

  minersOf(team) {
    return this.miners.filter((m) => m.team === team);
  }

  maxHp(m) {
    return C.hp[m.level - 1] + this.teams[m.team].mod.hp;
  }

  hasBomb(team) {
    return this.teams[team].stock.includes('bomb') || this.miners.some((m) => m.team === team && m.carry === 'bomb');
  }

  share(team) {
    const a = this.teams[team].litCount;
    const b = this.teams[1 - team].litCount;
    return a + b === 0 ? 0.5 : a / (a + b);
  }

  moveTime(m, i) {
    const slow = this.mud[i] >= 0 && this.mud[i] !== m.team ? C.mudMul : 1;
    return C.moveTicks * C.moveMul[m.level - 1] * m.buffs.speed * slow * this.load(m);
  }

  digTime(m, i) {
    const mod = this.teams[m.team].mod.dig;
    return C.digTicks * C.digMul[m.level - 1] * m.buffs.dig * mod * (this.tiles[i] === T.HARD ? C.hardMul : 1) * this.load(m);
  }

  // 炸彈很重：拿著炸彈的礦工走路和挖掘都變慢
  load(m) {
    return m.carry === 'bomb' ? C.bombSlow : 1;
  }

  msg(to, text, kind = 'info') {
    this.events.push({ type: 'msg', to, text, kind });
  }

  fx(kind, x, y, extra = {}) {
    this.events.push({ type: 'fx', kind, x, y, ...extra });
  }

  structAt(x, y) {
    const at = (s) => s.x === x && s.y === y;
    return this.lasers.some(at) || this.spikes.some(at) || this.portals.some(at);
  }

  canBuild(x, y) {
    const i = idx(x, y);
    return (
      this.tiles[i] === T.FLOOR &&
      this.homeAt[i] < 0 &&
      this.mineAt[i] < 0 &&
      !(x === this.treasure.x && y === this.treasure.y && !this.treasure.taken) &&
      !this.structAt(x, y)
    );
  }

  // ---------- 指令 ----------

  command(team, cmd) {
    this.queue.push([team, cmd]);
  }

  applyCommand(team, c) {
    const tm = this.teams[team];
    const m = c.minerId != null ? this.miners.find((x) => x.id === c.minerId && x.team === team) : null;
    const up = m && m.state !== 'fountain';
    switch (c.type) {
      case 'move':
        // queue：排在目前任務後面；use：走到之後自動使用手上的道具
        if (up && inb(c.x | 0, c.y | 0)) {
          const task = { type: 'move', x: c.x | 0, y: c.y | 0, use: c.use === true };
          if (c.queue === true && m.task) {
            if (m.queue.length < C.maxQueue) m.queue.push(task);
          } else {
            m.task = task;
            m.queue.length = 0;
          }
        }
        break;
      case 'pickup':
        if (up && typeof c.item === 'string' && tm.stock.includes(c.item)) {
          m.task = { type: 'pickup', item: c.item };
          m.queue.length = 0;
        }
        break;
      case 'use':
        if (up && m.carry && m.carry !== 'bomb') {
          // 可以指定朝哪個方向用（TNT 會用到）
          if (Number.isInteger(c.dx) && Number.isInteger(c.dy) && Math.abs(c.dx) + Math.abs(c.dy) === 1) m.dir = [c.dx, c.dy];
          m.useQueued = true;
        }
        break;
      case 'stop':
        if (m) {
          m.task = null;
          m.path = null;
          m.eta = 0;
          m.queue.length = 0;
        }
        break;
      case 'auto':
        if (m) m.auto = c.on === true;
        break;
      case 'buy':
        this.buy(team, c.item);
        break;
      case 'upgrade': {
        if (!m || m.level >= 3) break;
        const cost = C.upgradeCost[m.level - 1];
        if (tm.money < cost) {
          this.msg(team, '錢不夠升級。', 'bad');
          break;
        }
        tm.money -= cost;
        tm.stats.spent += cost;
        m.invested += cost;
        m.level++;
        m.hp = Math.min(this.maxHp(m), m.hp + 1);
        this.msg(team, `${m.n} 號礦工升到 Lv${m.level}。`, 'good');
        break;
      }
      case 'sell': {
        if (!m) break;
        if (this.minersOf(team).length <= 1) {
          this.msg(team, '至少要留一名礦工。', 'bad');
          break;
        }
        const refund = C.sellBase + Math.floor(m.invested / 2);
        tm.money += refund;
        this.miners.splice(this.miners.indexOf(m), 1);
        m.sold = true;
        this.msg(team, `賣掉 ${m.n} 號礦工，拿回 $${refund}${m.carry ? '（手上的道具也沒了）' : ''}。`, 'info');
        break;
      }
      case 'emote':
        this.events.push({ type: 'emote', team, id: String(c.id).slice(0, 12) });
        break;
      case 'taunt':
        this.events.push({ type: 'taunt', team });
        break;
      case 'surrender':
        this.finish(1 - team, 'surrender');
        break;
    }
  }

  price(team, item) {
    return priceOf(item, this.teams[team].mod.price);
  }

  buy(team, item) {
    if (typeof item !== 'string' || !Object.hasOwn(ITEMS, item)) return;
    const def = ITEMS[item];
    const tm = this.teams[team];
    const price = this.price(team, item);
    const fail = (t) => this.msg(team, t, 'bad');
    if (tm.money < price) return fail(`錢不夠買${def.name}。`);
    if (item === 'bomb' && this.hasBomb(team)) return fail('炸彈同時只能有一個。');
    if (item === 'miner' && this.minersOf(team).length >= C.maxMiners) return fail(`礦工最多 ${C.maxMiners} 名。`);
    if ((item === 'intel1' || item === 'intel2') && tm.confirmedHome >= 0) return fail('已經知道敵方的家在哪了。');
    if (item === 'intel1' && tm.intelZone) return fail('已經有概略情報了。');
    tm.money -= price;
    tm.stats.spent += price;
    if (item === 'miner') {
      const m = this.spawnMiner(team);
      this.msg(team, `新礦工（${m.n} 號）在家裡報到。`, 'good');
    } else if (item === 'intel1') {
      const e = this.homes[1 - team];
      const ox = 2 + Math.floor(this.rng() * 7);
      const oy = 2 + Math.floor(this.rng() * 7);
      tm.intelZone = {
        x: Math.min(W - 11, Math.max(0, e.cx - ox)),
        y: Math.min(H - 11, Math.max(0, e.cy - oy)),
        w: 11,
        h: 11,
      };
      this.msg(team, '概略情報：敵方的家就在地圖上標出的範圍裡。', 'good');
    } else if (item === 'intel2') {
      this.revealHome(team);
      this.msg(team, '精確情報：敵方的家已標在地圖上。', 'good');
    } else {
      tm.stock.push(item);
      this.msg(team, `${def.name}已送到家裡，派礦工回家拿。`, 'info');
    }
  }

  revealHome(team) {
    const tm = this.teams[team];
    const h = 1 - team;
    const hm = this.homes[h];
    tm.confirmedHome = h;
    tm.seenHomes.add(h);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tm.know[idx(hm.cx + dx, hm.cy + dy)] = T.FLOOR;
  }

  // ---------- 每個 tick ----------

  step() {
    if (this.over) return;
    const q = this.queue;
    this.queue = [];
    for (const [team, cmd] of q) {
      this.applyCommand(team, cmd);
      if (this.over) return;
    }
    this.tick++;
    for (const m of this.miners.slice()) {
      if (m.sold) continue;
      this.stepMiner(m);
      if (this.over) return;
    }
    this.combat();
    this.stepLasers();
    this.stepMines();
    this.stepTreasure();
    if (this.tick % TPS === 0) this.income();
    this.updateVision();
    this.alerts();
    if (this.tick === C.announceVisionTick) {
      this.visionAnnounced = true;
      this.events.push({ type: 'vision', lit: [this.teams[0].litCount, this.teams[1].litCount] });
    }
    if (this.tick >= MATCH_TICKS) {
      const a = this.teams[0].litCount;
      const b = this.teams[1].litCount;
      this.finish(a > b ? 0 : b > a ? 1 : -1, 'vision');
    }
  }

  finish(winner, reason) {
    if (this.over) return;
    this.over = { winner, reason, lit: [this.teams[0].litCount, this.teams[1].litCount], tick: this.tick };
  }

  income() {
    for (const tm of this.teams) tm.money += C.homeIncome;
    for (const mn of this.mines) {
      if (mn.owner >= 0) this.teams[mn.owner].money += mn.neutral ? C.neutralIncome : C.mineIncome;
    }
  }

  // ---------- 礦工 ----------

  stepMiner(m) {
    if (m.state === 'fountain') {
      if (--m.respawn <= 0) this.respawn(m);
      return;
    }
    if (m.atkCd > 0) m.atkCd--;
    if (m.frozen > 0) {
      m.frozen--;
      return;
    }
    if (this.tick % TPS === 0 && m.hp < this.maxHp(m) && this.homeAt[idx(m.x, m.y)] === m.team) m.hp++;
    if (m.act) {
      m.act.left -= 1;
      if (m.act.left > 0) return;
      this.finishAct(m);
      if (m.state === 'fountain' || this.over) return;
    }
    this.chooseAct(m);
  }

  chooseAct(m) {
    const tm = this.teams[m.team];
    // 目前的任務結束（做完或做不到）：接著做排隊中的下一個
    const clear = () => {
      m.task = m.queue.length ? m.queue.shift() : null;
      m.path = null;
      m.eta = 0;
    };
    if (m.useQueued) {
      m.useQueued = false;
      if (m.carry && m.carry !== 'bomb') {
        m.act = { kind: 'use', left: C.useTicks, total: C.useTicks };
        return;
      }
    }
    if (this.canTorch(m)) {
      m.act = { kind: 'torch', left: C.torchTicks, total: C.torchTicks };
      return;
    }
    let t = m.task;
    if (!t && m.auto && m.carry !== 'bomb' && this.tick >= m.autoAt && !this.capturing(m)) {
      const p = this.autoTarget(m);
      if (p) t = m.task = { type: 'move', x: p.x, y: p.y, use: false };
      else m.autoAt = this.tick + 20;
    }
    if (!t) {
      m.path = null;
      m.eta = 0;
      return;
    }
    let gx;
    let gy;
    if (t.type === 'pickup') {
      if (!tm.stock.includes(t.item)) return clear();
      if (this.homeAt[idx(m.x, m.y)] === m.team) {
        this.doPickup(m, t.item);
        return clear();
      }
      gx = this.homes[m.team].cx;
      gy = this.homes[m.team].cy;
    } else {
      gx = t.x;
      gy = t.y;
    }
    if (m.x === gx && m.y === gy) {
      if (t.use && m.carry && m.carry !== 'bomb') m.useQueued = true;
      return clear();
    }
    const r = this.plan(m, gx, gy);
    if (!r) {
      this.msg(m.team, `${m.n} 號礦工到不了那裡。`, 'bad');
      return clear();
    }
    if (r.path.length === 0) return clear();
    m.path = r.path;
    m.eta = r.cost;
    const next = r.path[0];
    const nx = next % W;
    const ny = (next / W) | 0;
    if (man(m.x, m.y, nx, ny) !== 1) {
      m.act = { kind: 'teleport', to: next, left: C.teleportTicks, total: C.teleportTicks };
      return;
    }
    m.dir = [nx - m.x, ny - m.y];
    const actual = this.tiles[next];
    tm.know[next] = actual;
    if (actual === T.ROCK) return; // 剛發現是石頭，下一個 tick 重新找路
    const h = this.homeAt[next];
    if (h >= 0 && this.homes[h].team !== m.team) {
      tm.seenHomes.add(h);
      if (m.carry !== 'bomb') return;
    }
    if (isWall(actual)) {
      const d = this.digTime(m, next);
      m.act = { kind: 'dig', to: next, left: d, total: d };
    } else {
      const d = this.moveTime(m, next);
      m.act = { kind: 'walk', to: next, left: d, total: d };
    }
  }

  // 站在還沒拿下的礦井或大寶藏上（正在佔領或兩隊在搶）：自動探索不會把他叫走。
  capturing(m) {
    const tr = this.treasure;
    if (!tr.taken && tr.x === m.x && tr.y === m.y) return true;
    return this.mines.some((mn) => mn.x === m.x && mn.y === m.y && mn.owner !== m.team);
  }

  // 自動探索：在附近挑一個還沒照亮的地方去挖（只用這一隊自己知道的資訊）。
  autoTarget(m) {
    const tm = this.teams[m.team];
    const home = this.homes[m.team];
    const r = this.rng;
    const here = man(m.x, m.y, home.cx, home.cy);
    let best = null;
    let bs = -Infinity;
    const consider = (x, y, bonus) => {
      if (x < 1 || y < 1 || x > W - 2 || y > H - 2) return;
      const i = idx(x, y);
      const k = tm.know[i];
      if (k === T.ROCK) return;
      if (tm.lit[i] && !bonus) return;
      const h = this.homeAt[i];
      if (h >= 0 && (this.homes[h].team === m.team || tm.seenHomes.has(h))) return;
      let s = bonus + r() * 1.5 - 0.15 * man(m.x, m.y, x, y);
      if (!tm.lit[i]) s += 3;
      if (k === UNKNOWN) s += 1;
      // 稍微偏好離家遠的方向，視野才會往外擴
      s += 0.06 * (man(x, y, home.cx, home.cy) - here);
      if (s > bs) {
        bs = s;
        best = { x, y };
      }
    };
    for (let k = 0; k < 18; k++) {
      const d = 3 + Math.floor(r() * 6);
      const a = r() * Math.PI * 2;
      consider(m.x + Math.round(Math.cos(a) * d), m.y + Math.round(Math.sin(a) * d), 0);
    }
    // 看得到的金礦脈優先
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const x = m.x + dx;
        const y = m.y + dy;
        if (!inb(x, y)) continue;
        const i = idx(x, y);
        if (tm.knowOre[i] && isWall(tm.know[i])) consider(x, y, 4);
      }
    }
    return best;
  }

  // 以該隊「知道的地形」找路：沒看過的格子當成土。
  plan(m, gx, gy) {
    const team = m.team;
    const tm = this.teams[team];
    const bomb = m.carry === 'bomb';
    const mv = C.moveTicks * C.moveMul[m.level - 1] * m.buffs.speed * this.load(m);
    const dg = C.digTicks * C.digMul[m.level - 1] * m.buffs.dig * tm.mod.dig * this.load(m);
    const know = tm.know;
    // 已經開過火、位置曝光的敵方激光塔：盡量繞開它的射程
    let danger = null;
    for (const L of this.lasers) {
      if (L.team === team || !L.revealed) continue;
      danger = danger || new Uint8Array(N);
      diamond(danger, L.x, L.y, C.laserRange);
    }
    const cost = (i) => {
      const risk = danger && danger[i] ? C.laserAvoid : 0;
      const h = this.homeAt[i];
      if (h >= 0 && this.homes[h].team !== team && tm.seenHomes.has(h)) return bomb ? mv + risk : Infinity;
      let k = know[i];
      if (k === UNKNOWN) k = T.DIRT;
      if (k === T.ROCK) return Infinity;
      if (k === T.FLOOR) return (this.mud[i] >= 0 && this.mud[i] !== team && tm.visible[i] ? mv * C.mudMul : mv) + risk;
      return (k === T.HARD ? dg * C.hardMul : dg) + mv + risk;
    };
    let edges = null;
    const ps = this.portals.filter((p) => p.team === team);
    if (ps.length) {
      edges = new Map();
      const hc = idx(this.homes[team].cx, this.homes[team].cy);
      const fromHome = [];
      for (const p of ps) {
        const pi = idx(p.x, p.y);
        edges.set(pi, [{ to: hc, cost: C.teleportTicks }]);
        fromHome.push({ to: pi, cost: C.teleportTicks });
      }
      edges.set(hc, fromHome);
    }
    // 目標是進不去的敵方的家（沒帶炸彈）：改走到家外面一圈最近的位置
    let alts = null;
    const gh = this.homeAt[idx(gx, gy)];
    if (gh >= 0 && !bomb && this.homes[gh].team !== team && tm.seenHomes.has(gh)) {
      const hm = this.homes[gh];
      alts = [];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === 2 && inb(hm.cx + dx, hm.cy + dy)) alts.push(idx(hm.cx + dx, hm.cy + dy));
        }
      }
    }
    return dijkstra(idx(m.x, m.y), idx(gx, gy), cost, edges, alts);
  }

  finishAct(m) {
    const a = m.act;
    m.act = null;
    const tm = this.teams[m.team];
    switch (a.kind) {
      case 'dig': {
        if (isWall(this.tiles[a.to])) {
          const gold = this.ore[a.to] === 1;
          this.tiles[a.to] = T.FLOOR;
          this.ore[a.to] = 0;
          tm.money += gold ? C.oreMoney : C.dirtMoney;
          tm.stats.dug++;
          if (gold) this.fx('coin', a.to % W, (a.to / W) | 0, { team: m.team, amount: C.oreMoney });
        }
        break;
      }
      case 'walk':
      case 'teleport':
        this.arrive(m, a.to);
        break;
      case 'torch': {
        const i = idx(m.x, m.y);
        if (this.torch[i] < 0 && this.tiles[i] === T.FLOOR && this.homeAt[i] < 0) {
          this.torch[i] = m.team;
          this.litDirty[m.team] = true;
        }
        break;
      }
      case 'use':
        this.useItem(m);
        break;
    }
  }

  arrive(m, to) {
    m.x = to % W;
    m.y = (to / W) | 0;
    const sk = this.spikes.findIndex((s) => s.team !== m.team && s.x === m.x && s.y === m.y);
    if (sk >= 0) {
      this.spikes.splice(sk, 1);
      this.fx('spike', m.x, m.y);
      this.kill(m, 'spike', 1 - m.team);
      return;
    }
    const h = this.homeAt[to];
    if (h < 0) return;
    const hm = this.homes[h];
    if (hm.team === m.team) {
      if (!hm.fake) m.hp = this.maxHp(m);
    } else if (m.carry === 'bomb') {
      m.carry = null;
      this.fx('boom', hm.cx, hm.cy, { big: true });
      if (hm.fake) {
        this.removeHome(h);
        m.task = null;
        this.msg(m.team, '炸到的是假的家！炸彈白費了。', 'bad');
        this.msg(hm.team, '敵方的炸彈炸在假的家上，騙到了！', 'good');
      } else {
        this.finish(m.team, 'bomb');
      }
    }
  }

  removeHome(h) {
    const hm = this.homes[h];
    hm.dead = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.homeAt[idx(hm.cx + dx, hm.cy + dy)] = -1;
    for (const tm of this.teams) tm.seenHomes.delete(h);
  }

  // 火把由礦工自動插：站在沒被自己照亮、也沒被敵方照亮的通道上就會插一根。
  canTorch(m) {
    const i = idx(m.x, m.y);
    if (this.tiles[i] !== T.FLOOR || this.homeAt[i] >= 0 || this.mineAt[i] >= 0 || this.torch[i] >= 0) return false;
    if (m.x === this.treasure.x && m.y === this.treasure.y) return false;
    return !this.teams[m.team].lit[i] && !this.teams[1 - m.team].lit[i];
  }

  doPickup(m, item) {
    const tm = this.teams[m.team];
    const k = tm.stock.indexOf(item);
    if (k < 0) return;
    const def = ITEMS[item];
    if (def.buff) {
      const has = def.buff === 'vision' ? m.buffs.vision > 0 : def.buff === 'speed' ? m.buffs.speed < 1 : m.buffs.dig < 1;
      if (has) {
        this.msg(m.team, `${m.n} 號礦工已經有${def.name}了。`, 'bad');
        return;
      }
      tm.stock.splice(k, 1);
      if (def.buff === 'vision') m.buffs.vision = 2;
      else if (def.buff === 'speed') m.buffs.speed = 0.75;
      else m.buffs.dig = 0.6;
      this.msg(m.team, `${m.n} 號礦工裝上了${def.name}。`, 'good');
      return;
    }
    tm.stock.splice(k, 1);
    if (m.carry) tm.stock.push(m.carry);
    m.carry = item;
    this.msg(m.team, `${m.n} 號礦工拿了${def.name}。`, 'info');
  }

  kill(m, cause, byTeam) {
    if (m.state === 'fountain') return;
    if (m.carry === 'bomb') {
      this.msg(m.team, '炸彈跟著礦工一起沒了，要再買一顆。', 'bad');
      this.msg(1 - m.team, '攔下了敵方的炸彈！', 'good');
    }
    this.fx('death', m.x, m.y, { team: m.team });
    const hm = this.homes[m.team];
    m.carry = null;
    m.buffs = { vision: 0, speed: 1, dig: 1 };
    m.act = null;
    m.task = null;
    m.path = null;
    m.eta = 0;
    m.frozen = 0;
    m.useQueued = false;
    m.queue.length = 0;
    m.state = 'fountain';
    m.respawn = C.respawnTicks;
    m.x = hm.cx;
    m.y = hm.cy;
    this.teams[m.team].stats.deaths++;
    if (byTeam >= 0) this.teams[byTeam].stats.kills++;
    this.msg(m.team, `${m.n} 號礦工${CAUSE[cause] || '被擊殺'}，回泉水蹲 ${C.respawnTicks / TPS} 秒。`, 'bad');
    if (byTeam >= 0) this.msg(byTeam, '擊殺了一名敵方礦工！', 'good');
  }

  respawn(m) {
    const hm = this.homes[m.team];
    m.state = 'idle';
    m.hp = this.maxHp(m);
    m.x = hm.cx;
    m.y = hm.cy;
    this.msg(m.team, `${m.n} 號礦工復活了。`, 'info');
  }

  // ---------- 道具 ----------

  useItem(m) {
    const it = m.carry;
    if (!it || it === 'bomb') return;
    const team = m.team;
    const en = 1 - team;
    let ok = true;
    switch (it) {
      case 'snuff': {
        let n = 0;
        const r = C.snuffRange;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > r || !inb(m.x + dx, m.y + dy)) continue;
            const j = idx(m.x + dx, m.y + dy);
            if (this.torch[j] === en) {
              this.torch[j] = -1;
              n++;
            }
          }
        }
        if (n) this.litDirty[en] = true;
        this.fx('snuff', m.x, m.y);
        this.msg(team, n ? `拆掉了 ${n} 根敵方火把。` : '附近沒有敵方火把，道具白用了。', n ? 'good' : 'bad');
        if (n) this.msg(en, `敵方拆掉了你 ${n} 根火把！`, 'bad');
        break;
      }
      case 'hard':
      case 'mud': {
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (!inb(m.x + dx, m.y + dy)) continue;
            const j = idx(m.x + dx, m.y + dy);
            if (it === 'hard' && this.tiles[j] === T.DIRT) {
              this.tiles[j] = T.HARD;
              n++;
            } else if (it === 'mud' && this.tiles[j] === T.FLOOR && this.homeAt[j] < 0 && this.mineAt[j] < 0) {
              this.mud[j] = team;
              n++;
            }
          }
        }
        this.msg(team, it === 'hard' ? `把周圍 ${n} 格土變成硬土。` : `把周圍 ${n} 格通道變成泥地。`, 'good');
        break;
      }
      case 'laser':
      case 'spike':
      case 'portal': {
        if (!this.canBuild(m.x, m.y)) {
          ok = false;
          break;
        }
        if (it === 'laser') this.lasers.push({ team, x: m.x, y: m.y, cd: 10, revealed: false });
        else if (it === 'spike') this.spikes.push({ team, x: m.x, y: m.y });
        else this.portals.push({ team, x: m.x, y: m.y });
        this.msg(team, `${ITEMS[it].name}放好了。`, 'good');
        break;
      }
      case 'spell': {
        let n = 0;
        for (const e of this.miners) {
          if (e.team === team || e.state === 'fountain') continue;
          if (man(m.x, m.y, e.x, e.y) <= C.spellRange) {
            e.frozen = C.freezeTicks;
            n++;
          }
        }
        this.teams[en].pings.push({ x: m.x, y: m.y, r: 2, until: this.tick + 30 });
        this.fx('freeze', m.x, m.y, { team });
        this.msg(team, n ? `凍住了 ${n} 名敵方礦工！` : '附近沒有敵方礦工，法術白用了。', n ? 'good' : 'bad');
        if (n) this.msg(en, '你的礦工被冰凍了！', 'bad');
        break;
      }
      case 'fake':
        ok = this.buildFake(m);
        break;
      case 'tnt':
        this.blast(m);
        break;
    }
    if (ok) m.carry = null;
    else this.msg(team, '這裡不能放，換個位置再用一次。', 'bad');
  }

  // 以 (cx, cy) 為中心的 3×3 能不能蓋假的家
  fakeSpot(cx, cy) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inb(x, y)) return false;
        const j = idx(x, y);
        if (this.tiles[j] === T.ROCK || this.homeAt[j] >= 0 || this.mineAt[j] >= 0) return false;
        if (x === this.treasure.x && y === this.treasure.y) return false;
        if (this.structAt(x, y)) return false;
      }
    }
    return true;
  }

  addFake(team, cx, cy) {
    this.homes.push({ team, cx, cy, fake: true, dead: false });
    this.stampHome(this.homes.length - 1);
  }

  buildFake(m) {
    if (!this.fakeSpot(m.x, m.y)) return false;
    this.addFake(m.team, m.x, m.y);
    this.msg(m.team, '假的家蓋好了。', 'good');
    return true;
  }

  // 大寶藏的獎勵：在自己這一側隨機挑一個地方蓋假的家（和真的家出現的範圍一樣，敵方分不出來）
  randomFake(team) {
    const tm = this.teams[team];
    const real = this.homes[team];
    const x0 = team === 0 ? 5 : W - 12;
    for (let k = 0; k < 400; k++) {
      // 前 300 次只找自己這一側，真的找不到才放寬到整張地圖
      const cx = k < 300 ? x0 + Math.floor(this.rng() * 7) : 2 + Math.floor(this.rng() * (W - 4));
      const cy = 6 + Math.floor(this.rng() * (H - 12));
      if (man(cx, cy, real.cx, real.cy) < 8 || !this.fakeSpot(cx, cy)) continue;
      if (this.miners.some((m) => m.state !== 'fountain' && Math.abs(m.x - cx) <= 1 && Math.abs(m.y - cy) <= 1)) continue;
      this.addFake(team, cx, cy);
      // 自己知道它在哪（假的家本身沒有視野）
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = idx(cx + dx, cy + dy);
          tm.know[j] = T.FLOOR;
          tm.knowOre[j] = 0;
        }
      }
      this.fx('capture', cx, cy, { team });
      return true;
    }
    return false;
  }

  blast(m) {
    const team = m.team;
    const en = 1 - team;
    const [fx, fy] = m.dir;
    const px = -fy;
    const py = fx;
    for (let d = 1; d <= 4; d++) {
      for (let l = -1; l <= 1; l++) {
        const x = m.x + fx * d + px * l;
        const y = m.y + fy * d + py * l;
        if (!inb(x, y)) continue;
        const j = idx(x, y);
        if (this.homeAt[j] >= 0) continue;
        if (isWall(this.tiles[j])) {
          this.tiles[j] = T.FLOOR;
          this.ore[j] = 0;
        }
        if (this.torch[j] === en) {
          this.torch[j] = -1;
          this.litDirty[en] = true;
        }
        const hit = (s) => s.team === en && s.x === x && s.y === y;
        this.lasers = this.lasers.filter((s) => !hit(s));
        this.spikes = this.spikes.filter((s) => !hit(s));
        this.portals = this.portals.filter((s) => !hit(s));
        for (const e of this.miners) if (e.team === en && e.state !== 'fountain' && e.x === x && e.y === y) this.kill(e, 'tnt', team);
      }
    }
    const cx = m.x + fx * 2;
    const cy = m.y + fy * 2;
    this.fx('boom', inb(cx, cy) ? cx : m.x, inb(cx, cy) ? cy : m.y, { team });
    if (inb(cx, cy)) {
      const j = idx(cx, cy);
      if (this.tiles[j] === T.FLOOR && this.homeAt[j] < 0 && this.torch[j] < 0) {
        this.torch[j] = team;
        this.litDirty[team] = true;
      }
    }
    this.teams[en].pings.push({ x: m.x, y: m.y, r: 2, until: this.tick + 20 });
    this.msg(team, 'TNT 炸開了一條路。', 'good');
  }

  // ---------- 戰鬥、設施、據點 ----------

  // 相鄰的敵對礦工會自動互打；拿著炸彈的礦工不能出手。
  combat() {
    const hits = [];
    for (const m of this.miners) {
      if (m.state === 'fountain' || m.frozen > 0 || m.atkCd > 0 || m.carry === 'bomb') continue;
      let target = null;
      let score = Infinity;
      for (const e of this.miners) {
        if (e.team === m.team || e.state === 'fountain') continue;
        if (man(m.x, m.y, e.x, e.y) > 1) continue;
        const s = e.carry === 'bomb' ? -1 : e.hp;
        if (s < score) {
          score = s;
          target = e;
        }
      }
      if (target) {
        hits.push([m, target]);
        m.atkCd = C.attackCd;
      }
    }
    for (const [m, e] of hits) {
      if (e.state === 'fountain') continue;
      e.hp--;
      this.fx('hit', e.x, e.y);
      if (e.hp <= 0) this.kill(e, 'melee', m.team);
    }
  }

  stepLasers() {
    for (const L of this.lasers) {
      if (L.cd > 0) {
        L.cd--;
        continue;
      }
      let target = null;
      let bd = Infinity;
      for (const e of this.miners) {
        if (e.team === L.team || e.state === 'fountain') continue;
        const d = man(L.x, L.y, e.x, e.y);
        if (d <= C.laserRange && d < bd) {
          bd = d;
          target = e;
        }
      }
      if (!target) continue;
      L.cd = C.laserCd;
      L.revealed = true;
      this.fx('laser', L.x, L.y, { x2: target.x, y2: target.y });
      this.teams[target.team].pings.push({ x: L.x, y: L.y, r: 1, until: this.tick + 30 });
      this.kill(target, 'laser', L.team);
    }
  }

  // 回傳獨佔該格的隊伍；沒人或兩隊都在則回傳 -1。
  holder(x, y) {
    let c0 = 0;
    let c1 = 0;
    for (const m of this.miners) {
      if (m.state === 'fountain' || m.x !== x || m.y !== y) continue;
      if (m.team === 0) c0++;
      else c1++;
    }
    return c0 && !c1 ? 0 : c1 && !c0 ? 1 : -1;
  }

  stepMines() {
    for (const mn of this.mines) {
      const t = this.holder(mn.x, mn.y);
      if (t < 0 || mn.owner === t) {
        mn.prog = 0;
        mn.progTeam = -1;
        continue;
      }
      if (mn.progTeam !== t) {
        mn.progTeam = t;
        mn.prog = 0;
      }
      if (++mn.prog < C.captureTicks) continue;
      const prev = mn.owner;
      mn.owner = t;
      mn.prog = 0;
      mn.progTeam = -1;
      this.teams[t].stats.mines++;
      this.teams[t].mineSeen[mn.id] = t;
      if (prev >= 0) this.teams[prev].mineSeen[mn.id] = t;
      this.fx('capture', mn.x, mn.y, { team: t });
      this.msg(t, `佔領了${mn.neutral ? '中立' : ''}礦井，開始生錢！`, 'good');
      if (prev >= 0) this.msg(prev, '你的礦井被敵方搶走了！', 'bad');
    }
  }

  stepTreasure() {
    const tr = this.treasure;
    if (tr.taken) return;
    const t = this.holder(tr.x, tr.y);
    if (t < 0) {
      tr.prog = 0;
      tr.progTeam = -1;
      return;
    }
    if (tr.progTeam !== t) {
      tr.progTeam = t;
      tr.prog = 0;
    }
    if (++tr.prog < C.treasureTicks) return;
    tr.taken = true;
    this.teams[t].money += C.treasureMoney;
    this.fx('capture', tr.x, tr.y, { team: t });
    const built = this.randomFake(t);
    this.msg(t, `搶到大寶藏！拿到 $${C.treasureMoney}${built ? '，地圖上還多了一個假的家可以騙對手的炸彈' : ''}。`, 'good');
    this.msg(1 - t, '敵方搶到了大寶藏！', 'bad');
  }

  // 敵方礦工出現在家附近（且看得到）時提醒該隊：一般 15 秒最多一次，帶炸彈的 6 秒最多一次。
  alerts() {
    for (const tm of this.teams) {
      const hm = this.homes[tm.id];
      for (const e of this.miners) {
        if (e.team === tm.id || e.state === 'fountain' || !tm.visible[idx(e.x, e.y)]) continue;
        if (man(e.x, e.y, hm.cx, hm.cy) > 8) continue;
        const bomb = e.carry === 'bomb';
        if ((bomb ? tm.bombAlertUntil : tm.alertUntil) > this.tick) continue;
        if (bomb) tm.bombAlertUntil = this.tick + 60;
        tm.alertUntil = this.tick + 150;
        this.events.push({
          type: 'msg',
          to: tm.id,
          kind: 'alert',
          text: bomb ? '敵方礦工帶著炸彈衝向你的家！' : '敵方礦工出現在你家附近！',
          x: e.x,
          y: e.y,
        });
        break;
      }
    }
  }

  // ---------- 視野 ----------

  updateVision() {
    for (const tm of this.teams) {
      const t = tm.id;
      if (this.litDirty[t]) {
        const lit = tm.lit;
        lit.fill(0);
        diamond(lit, this.homes[t].cx, this.homes[t].cy, C.homeVision);
        const torch = this.torch;
        for (let i = 0; i < N; i++) {
          if (torch[i] !== t) continue;
          const x = i % W;
          const y = (i / W) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inb(x + dx, y + dy)) lit[i + dy * W + dx] = 1;
        }
        let n = 0;
        for (let i = 0; i < N; i++) n += lit[i];
        tm.litCount = n;
        this.litDirty[t] = false;
      }
      const vis = tm.visible;
      vis.set(tm.lit);
      for (const m of this.miners) {
        if (m.team === t && m.state !== 'fountain') diamond(vis, m.x, m.y, C.minerVision + m.buffs.vision + tm.mod.vision);
      }
      if (tm.pings.length) {
        tm.pings = tm.pings.filter((p) => p.until > this.tick);
        for (const p of tm.pings) diamond(vis, p.x, p.y, p.r);
      }
      const { know, knowOre } = tm;
      for (let i = 0; i < N; i++) {
        if (!vis[i]) continue;
        know[i] = this.tiles[i];
        knowOre[i] = this.ore[i];
        const mi = this.mineAt[i];
        if (mi >= 0) tm.mineSeen[mi] = this.mines[mi].owner;
        if (mi >= 0 && !tm.knownMines.has(mi)) {
          tm.knownMines.add(mi);
          this.msg(t, '發現一座礦井！派礦工站上去 3 秒就能佔領。', 'info');
        }
        const h = this.homeAt[i];
        if (h >= 0 && this.homes[h].team !== t && !tm.seenHomes.has(h)) {
          tm.seenHomes.add(h);
          this.msg(t, '發現敵方的家！', 'good');
        }
      }
    }
  }
}
