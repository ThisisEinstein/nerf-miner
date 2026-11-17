// 電腦對手。只用自己那一隊「看得到、知道的」資訊下指令，和玩家走同一套指令介面。
import { W, H, T, C, TPS, UNKNOWN, idx } from '../sim/constants.js';
import { ITEMS } from '../sim/items.js';
import { mulberry32 } from '../sim/rng.js';

const man = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const isWall = (t) => t === T.DIRT || t === T.HARD;
const EMOTES = ['smile', 'angry', 'cry', 'good'];

// 三種難度。時間單位是秒；every 與 rest 的單位是 tick。
export const LEVELS = {
  easy: { every: 12, minerAt: 40, intelAt: 150, attackAt: 180, rebuy: 60, lasers: 0, escort: false, defenders: 2, treasureAt: 35, rest: [30, 40] },
  normal: { every: 8, minerAt: 20, intelAt: 90, attackAt: 135, rebuy: 50, lasers: 1, escort: true, defenders: 2, treasureAt: 15, rest: [12, 20] },
  hard: { every: 5, minerAt: 10, intelAt: 55, attackAt: 95, rebuy: 40, lasers: 2, escort: true, defenders: 3, treasureAt: 8, rest: [6, 14] },
};

export class Bot {
  /** @param {'easy'|'normal'|'hard'} level */
  constructor(game, team, level = 'normal') {
    this.g = game;
    this.team = team;
    this.level = level;
    this.cfg = LEVELS[level] || LEVELS.normal;
    this.rng = mulberry32((game.seed ^ 0x00c0ffee) >>> 0);
    this.jobs = new Map();
    this.rest = new Map();
    this.lasers = 0;
    this.pick = false;
    this.taunted = false;
    this.hadBomb = true;
    this.bombLostAt = -1e9;
    this.nextEmote = 25 + this.rng() * 30;
  }

  cmd(c) {
    this.g.command(this.team, c);
  }

  update() {
    if (this.g.over || this.g.tick % this.cfg.every !== 0) return;
    this.think();
  }

  go(m, x, y) {
    if (m.x === x && m.y === y) return;
    const t = m.task;
    if (t && t.type === 'move' && t.x === x && t.y === y) return;
    this.cmd({ type: 'move', minerId: m.id, x, y });
  }

  pickup(m, item) {
    const t = m.task;
    if (t && t.type === 'pickup' && t.item === item) return;
    this.cmd({ type: 'pickup', minerId: m.id, item });
  }

  targetHome() {
    const g = this.g;
    const tm = g.teams[this.team];
    if (tm.confirmedHome >= 0) return g.homes[tm.confirmedHome];
    for (const h of tm.seenHomes) if (!g.homes[h].dead) return g.homes[h];
    return null;
  }

  think() {
    const g = this.g;
    const t = this.team;
    const cfg = this.cfg;
    const tm = g.teams[t];
    const sec = g.tick / TPS;
    const home = { x: g.homes[t].cx, y: g.homes[t].cy };
    const all = g.miners.filter((m) => m.team === t);
    const alive = all.filter((m) => m.state !== 'fountain');
    const foes = g.miners.filter((m) => m.team !== t && m.state !== 'fountain' && tm.visible[idx(m.x, m.y)]);
    const th = this.targetHome();
    const target = th ? { x: th.cx, y: th.cy } : null;
    const attackOk = sec >= cfg.attackAt;
    // 炸彈沒了（進攻失敗）就記下時間，隔一陣子才會再買
    const hasBomb = g.hasBomb(t);
    if (this.hadBomb && !hasBomb) this.bombLostAt = sec;
    this.hadBomb = hasBomb;

    this.shop(sec, all, target);

    for (const id of [...this.jobs.keys()]) if (!alive.some((m) => m.id === id)) this.jobs.delete(id);
    const free = new Set(alive);
    // 優先讓原本就在做這件事的礦工繼續做，否則找最近的
    const take = (kind, key, pos, maxDist = Infinity) => {
      let chosen = null;
      for (const m of free) {
        const j = this.jobs.get(m.id);
        if (j && j.kind === kind && j.key === key) {
          chosen = m;
          break;
        }
      }
      if (!chosen) {
        let bd = maxDist;
        for (const m of free) {
          const d = man(m, pos);
          if (d < bd) {
            bd = d;
            chosen = m;
          }
        }
      }
      if (chosen) {
        free.delete(chosen);
        this.jobs.set(chosen.id, { kind, key });
      }
      return chosen;
    };

    // 1. 送炸彈
    const carrier = alive.find((m) => m.carry === 'bomb');
    if (carrier) {
      free.delete(carrier);
      this.jobs.set(carrier.id, { kind: 'bomb', key: 0 });
      if (target && attackOk) this.go(carrier, target.x, target.y);
      else this.go(carrier, home.x, home.y);
    } else if (target && attackOk && tm.stock.includes('bomb')) {
      const m = take('bomb', 0, home);
      if (m) this.pickup(m, 'bomb');
    }

    // 2. 守家：敵人靠近就派人去擋，帶炸彈的優先
    const danger = (e) => man(e, home) - (e.carry === 'bomb' ? 100 : 0);
    const threats = foes.filter((e) => man(e, home) <= 11).sort((a, b) => danger(a) - danger(b));
    let defenders = 0;
    for (const e of threats) {
      if (defenders >= cfg.defenders) break;
      const m = take('def', e.id, e, 18);
      if (m) {
        this.go(m, e.x, e.y);
        defenders++;
      }
    }

    // 3. 殘血回家補
    for (const m of [...free]) {
      if (m.hp <= 1 && man(m, home) > 1) {
        free.delete(m);
        this.go(m, home.x, home.y);
      }
    }

    // 4. 放激光塔守家
    const lz = alive.find((m) => m.carry === 'laser');
    if (lz) {
      if (free.has(lz)) {
        free.delete(lz);
        const s = this.laserSpot(home);
        if (lz.x === s.x && lz.y === s.y) this.cmd({ type: 'use', minerId: lz.id });
        else this.go(lz, s.x, s.y);
      }
    } else if (tm.stock.includes('laser')) {
      const m = take('laser', 0, home);
      if (m) this.pickup(m, 'laser');
    }

    // 5. 回家拿增幅道具
    for (const it of ['pick', 'boots', 'scope']) {
      if (!tm.stock.includes(it)) continue;
      const b = ITEMS[it].buff;
      const m = [...free].find((x) => (b === 'vision' ? x.buffs.vision === 0 : b === 'speed' ? x.buffs.speed === 1 : x.buffs.dig === 1));
      if (m) {
        free.delete(m);
        this.pickup(m, it);
      }
    }

    // 6. 搶大寶藏
    if (!g.treasure.taken && sec > cfg.treasureAt && sec < 200 && free.size > 1) {
      const m = take('treasure', 0, g.treasure, 70);
      if (m) this.go(m, g.treasure.x, g.treasure.y);
    }

    // 7. 佔領知道位置的礦井
    const wanted = g.mines
      .filter((mn) => tm.knownMines.has(mn.id) && mn.owner !== t)
      .sort((a, b) => man(a, home) - man(b, home));
    let capturing = 0;
    for (const mn of wanted) {
      if (capturing >= 2 || free.size <= 1) break;
      const m = take('mine', mn.id, mn, 45);
      if (m) {
        this.go(m, mn.x, mn.y);
        capturing++;
      }
    }

    // 8. 護送炸彈
    if (carrier && target && attackOk && cfg.escort && free.size > 1) {
      const m = take('escort', 0, carrier, 40);
      if (m) this.go(m, target.x, target.y);
    }

    // 9. 其餘的人挖路擴張視野；編號最小的留在家附近
    let guard = true;
    for (const m of [...free].sort((a, b) => a.n - b.n)) {
      this.jobs.set(m.id, { kind: 'expand', key: 0 });
      if (!m.task && !m.act) {
        // 做完一段會停一下再下新指令，模擬人的反應時間
        const until = this.rest.get(m.id);
        if (until == null) {
          this.rest.set(m.id, g.tick + cfg.rest[0] + this.rng() * cfg.rest[1]);
        } else if (g.tick >= until) {
          this.rest.delete(m.id);
          const p = this.pickExpand(m, guard, home, target);
          if (p) this.go(m, p.x, p.y);
        }
      }
      guard = false;
    }

    // 表情與惡搞
    if (sec > this.nextEmote) {
      this.nextEmote = sec + 35 + this.rng() * 45;
      this.cmd({ type: 'emote', id: EMOTES[Math.floor(this.rng() * EMOTES.length)] });
    }
    if (!this.taunted && g.visionAnnounced && g.share(t) > 0.6) {
      this.taunted = true;
      this.cmd({ type: 'taunt' });
    }
  }

  shop(sec, all, target) {
    const g = this.g;
    const t = this.team;
    const cfg = this.cfg;
    const tm = g.teams[t];
    const n = all.length;
    let want = null;
    if (n < 4 && sec > cfg.minerAt) want = 'miner';
    else if (!target && sec > cfg.intelAt) want = 'intel2';
    else if (target && !g.hasBomb(t) && sec > cfg.attackAt - 10 && sec > this.bombLostAt + cfg.rebuy) want = 'bomb';
    else if (this.lasers < Math.min(1, cfg.lasers) && sec > 60) want = 'laser';
    else if (!this.pick && sec > 30) want = 'pick';
    else if (this.lasers < cfg.lasers && sec > 170) want = 'laser';
    else if (n < C.maxMiners && sec > 120 && tm.money > 200) want = 'miner';
    if (want) {
      if (tm.money >= ITEMS[want].price) {
        this.cmd({ type: 'buy', item: want });
        if (want === 'laser') this.lasers++;
        if (want === 'pick') this.pick = true;
      }
      return;
    }
    const m = all.filter((x) => x.level < 3).sort((a, b) => a.level - b.level)[0];
    if (m && tm.money >= C.upgradeCost[m.level - 1] + 60) this.cmd({ type: 'upgrade', minerId: m.id });
  }

  // 激光塔放在家門口的通道上
  laserSpot(home) {
    const g = this.g;
    const tm = g.teams[this.team];
    const toward = this.team === 0 ? 1 : -1;
    let best = null;
    let bs = -Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2 || Math.abs(dx) + Math.abs(dy) > 3) continue;
        const x = home.x + dx;
        const y = home.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (tm.know[idx(x, y)] !== T.FLOOR || !g.canBuild(x, y)) continue;
        const s = dx * toward - Math.abs(dy) * 0.5;
        if (s > bs) {
          bs = s;
          best = { x, y };
        }
      }
    }
    return best || { x: home.x + toward * 2, y: home.y };
  }

  pickExpand(m, guard, home, target) {
    const g = this.g;
    const tm = g.teams[this.team];
    const r = this.rng;
    const goal = target || { x: W - 1 - home.x, y: home.y };
    let best = null;
    let bs = -Infinity;
    const consider = (x, y, bonus) => {
      if (x < 1 || y < 1 || x > W - 2 || y > H - 2) return;
      const i = idx(x, y);
      const k = tm.know[i];
      if (k === T.ROCK) return;
      const h = g.homeAt[i];
      if (h >= 0 && (g.homes[h].team === this.team || tm.seenHomes.has(h))) return;
      const p = { x, y };
      let s = bonus + r() * 1.5 - 0.15 * man(m, p);
      if (!tm.lit[i]) s += 3;
      if (k === UNKNOWN) s += 1;
      if (guard) s -= 0.4 * Math.max(0, man(p, home) - 7);
      else s += 0.1 * (man(m, goal) - man(p, goal));
      if (s > bs) {
        bs = s;
        best = p;
      }
    };
    for (let k = 0; k < 18; k++) {
      const d = guard ? 2 + Math.floor(r() * 5) : 4 + Math.floor(r() * 6);
      const a = r() * Math.PI * 2;
      consider(m.x + Math.round(Math.cos(a) * d), m.y + Math.round(Math.sin(a) * d), 0);
    }
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        const x = m.x + dx;
        const y = m.y + dy;
        if (x < 1 || y < 1 || x > W - 2 || y > H - 2) continue;
        const i = idx(x, y);
        if (tm.knowOre[i] && isWall(tm.know[i])) consider(x, y, 4);
      }
    }
    return best;
  }
}
