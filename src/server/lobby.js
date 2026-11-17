// 大廳與房間：兩個玩家進同一個房間、都按準備後開打。
// 對局由伺服器跑（玩家只送指令），每個 tick 把「各自看得到的東西」送回去。
import { Game } from '../sim/game.js';
import { makeView, ViewEncoder } from '../sim/view.js';
import { ITEMS } from '../sim/items.js';
import { CHAR_IDS } from '../sim/chars.js';
import { randomBytes } from 'node:crypto';

const EMOTES = new Set(['smile', 'angry', 'cry', 'good', 'no']);
const CID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const MAX_CMDS_PER_SEC = 40;
const MAX_MSGS_PER_SEC = 120; // 所有訊息加起來；超過就斷線（正常玩不會到）

// 重連代號要猜不到，不然別人可以冒充斷線的玩家接回位子
const newCid = () => randomBytes(12).toString('hex');
const guestName = () => `礦工${1000 + Math.floor(Math.random() * 9000)}`;
const cleanName = (s) =>
  typeof s === 'string'
    ? s
        .replace(/[\u0000-\u001f\u007f<>&"'`]/g, '')
        .trim()
        .slice(0, 12)
    : '';
const int = (v) => Number.isInteger(v);
const isItem = (v) => typeof v === 'string' && Object.hasOwn(ITEMS, v);

// 只放行認得的指令與欄位，其他一律丟掉
export function cleanCmd(c) {
  if (!c || typeof c !== 'object') return null;
  switch (c.type) {
    case 'move':
      return int(c.minerId) && int(c.x) && int(c.y)
        ? { type: 'move', minerId: c.minerId, x: c.x, y: c.y, queue: c.queue === true, use: c.use === true }
        : null;
    case 'pickup':
      return int(c.minerId) && isItem(c.item) ? { type: 'pickup', minerId: c.minerId, item: c.item } : null;
    case 'use': {
      if (!int(c.minerId)) return null;
      const dir = int(c.dx) && int(c.dy) && Math.abs(c.dx) + Math.abs(c.dy) === 1;
      return dir ? { type: 'use', minerId: c.minerId, dx: c.dx, dy: c.dy } : { type: 'use', minerId: c.minerId };
    }
    case 'auto':
      return int(c.minerId) ? { type: 'auto', minerId: c.minerId, on: c.on === true } : null;
    case 'stop':
    case 'upgrade':
    case 'sell':
      return int(c.minerId) ? { type: c.type, minerId: c.minerId } : null;
    case 'buy':
      return isItem(c.item) ? { type: 'buy', item: c.item } : null;
    case 'emote':
      return EMOTES.has(c.id) ? { type: 'emote', id: c.id } : null;
    case 'taunt':
    case 'surrender':
      return { type: c.type };
    default:
      return null;
  }
}

export class Lobby {
  constructor(opts = {}) {
    this.accounts = opts.accounts || null;
    this.version = opts.version || '0';
    this.addrs = opts.addrs || [];
    this.graceMs = opts.graceMs ?? 30000; // 對局中斷線後，多久沒回來算輸
    this.countdownMs = opts.countdownMs ?? 3000;
    this.tickMs = opts.tickMs ?? 100;
    this.now = opts.now || (() => performance.now());
    this.clients = new Set();
    this.rooms = new Map();
    this.sweepAt = 0;
  }

  send(c, obj) {
    c.conn.send(JSON.stringify(obj));
  }

  userInfo(c) {
    return c.user && this.accounts ? this.accounts.info(c.user) : null;
  }

  connect(conn) {
    const c = { conn, cid: null, name: guestName(), user: null, token: null, room: null, rtt: 0, cmdAt: 0, cmdN: 0, busy: false };
    this.clients.add(c);
    let winAt = 0;
    let winN = 0;
    conn.onmessage = (text) => {
      const now = Date.now();
      if (now - winAt > 1000) {
        winAt = now;
        winN = 0;
      }
      if (++winN > MAX_MSGS_PER_SEC) return conn.close(1008);
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      try {
        this.handle(c, m);
      } catch (e) {
        console.error('處理訊息時出錯：', e);
      }
    };
    conn.onclose = () => this.drop(c);
    return c;
  }

  // ---------- 訊息 ----------

  handle(c, m) {
    if (m.t === 'hello') return this.hello(c, m);
    if (!c.cid) return; // 還沒打招呼之前什麼都不收
    switch (m.t) {
      case 'ping':
        if (Number.isFinite(m.rtt)) c.rtt = Math.max(0, Math.min(9999, Math.round(m.rtt)));
        this.send(c, { t: 'pong', ts: m.ts });
        break;
      case 'name': {
        if (c.user) break;
        const n = cleanName(m.name);
        if (!n) break;
        c.name = n;
        this.syncSeat(c);
        this.send(c, { t: 'me', name: c.name, user: null });
        break;
      }
      case 'register':
      case 'login':
        this.auth(c, m);
        break;
      case 'logout':
        if (this.accounts && c.token) this.accounts.logout(c.token);
        c.user = null;
        c.token = null;
        c.name = guestName();
        this.syncSeat(c);
        this.send(c, { t: 'auth', ok: true, name: c.name, user: null, token: null });
        break;
      case 'top':
        this.send(c, { t: 'top', list: this.accounts ? this.accounts.top(10) : [] });
        break;
      case 'create':
        this.createRoom(c, false);
        break;
      case 'quick':
        this.quick(c);
        break;
      case 'join':
        this.join(c, m.code);
        break;
      case 'leave':
        this.leave(c);
        break;
      case 'char': {
        const s = this.seatOf(c);
        if (s && c.room.state !== 'playing' && CHAR_IDS.includes(m.id)) {
          s.char = m.id;
          this.sendRoom(c.room);
        }
        break;
      }
      case 'ready':
        this.ready(c, !!m.on);
        break;
      case 'cmd':
        this.cmd(c, m.c);
        break;
    }
  }

  hello(c, m) {
    if (c.cid) return;
    let cid = typeof m.cid === 'string' && CID_RE.test(m.cid) ? m.cid : newCid();
    // 同一個代號已經在線上（例如複製分頁）：給新的這個另一個代號
    for (const o of this.clients) {
      if (o !== c && o.cid === cid) {
        cid = newCid();
        break;
      }
    }
    c.cid = cid;
    const n = cleanName(m.name);
    if (n) c.name = n;
    if (this.accounts && typeof m.token === 'string') {
      const u = this.accounts.byToken(m.token);
      if (u) {
        c.user = u.name;
        c.name = u.name;
        c.token = m.token;
      }
    }
    // 對局中斷線後回來：接回原本的位子
    let back = null;
    for (const room of this.rooms.values()) {
      const k = room.seats.findIndex((s) => s.cid === cid && !s.client);
      if (k >= 0) {
        back = { room, k };
        break;
      }
    }
    if (back) {
      const s = back.room.seats[back.k];
      s.client = c;
      s.offAt = 0;
      s.enc.reset();
      c.room = back.room;
      c.name = s.name;
    }
    this.send(c, { t: 'welcome', cid, name: c.name, user: this.userInfo(c), v: this.version, addrs: this.addrs });
    if (back) {
      this.sendRoom(back.room);
      if (back.room.state === 'playing') this.send(c, this.startMsg(back.room, back.k));
    }
  }

  async auth(c, m) {
    if (!this.accounts || c.busy) return;
    c.busy = true;
    let r;
    try {
      r = m.t === 'register' ? await this.accounts.register(m.name, m.pass, c.conn.ip) : await this.accounts.login(m.name, m.pass, c.conn.ip);
    } catch {
      r = { ok: false, error: '伺服器出錯了，請再試一次。' };
    }
    c.busy = false;
    if (!r.ok) return this.send(c, { t: 'auth', ok: false, error: r.error });
    c.user = r.user.name;
    c.name = r.user.name;
    c.token = r.token;
    this.syncSeat(c);
    this.send(c, { t: 'auth', ok: true, name: c.name, user: r.user, token: r.token });
  }

  // 名字或帳號變了：同步到房間裡的位子（對局中不改）
  syncSeat(c) {
    const s = this.seatOf(c);
    if (!s || c.room.state === 'playing') return;
    s.name = c.name;
    s.user = c.user;
    this.sendRoom(c.room);
  }

  // ---------- 房間 ----------

  seatOf(c) {
    return c.room ? c.room.seats.find((s) => s.client === c) || null : null;
  }

  makeSeat(c) {
    return { cid: c.cid, client: c, name: c.name, user: c.user, char: 'digger', ready: false, enc: new ViewEncoder(), offAt: 0, gone: false };
  }

  createRoom(c, open) {
    this.leave(c);
    let code;
    do code = String(1000 + Math.floor(Math.random() * 9000));
    while (this.rooms.has(code));
    const room = { code, open, state: 'lobby', seats: [this.makeSeat(c)], game: null, next: 0, cdEnd: 0, netAt: 0 };
    this.rooms.set(code, room);
    c.room = room;
    this.sendRoom(room);
    return room;
  }

  quick(c) {
    for (const room of this.rooms.values()) {
      if (room.open && room.state === 'lobby' && room.seats.length === 1 && room.seats[0].client !== c) return this.join(c, room.code);
    }
    this.createRoom(c, true);
  }

  join(c, code) {
    const room = this.rooms.get(String(code ?? '').trim());
    if (!room) return this.send(c, { t: 'error', msg: '找不到這個房間，檢查一下房號。' });
    if (room === c.room) return;
    if (room.state !== 'lobby' || room.seats.length >= 2) return this.send(c, { t: 'error', msg: '這個房間已經滿了或正在對戰中。' });
    this.leave(c);
    room.seats.push(this.makeSeat(c));
    c.room = room;
    this.sendRoom(room);
  }

  leave(c) {
    const room = c.room;
    if (!room) return;
    c.room = null;
    const k = room.seats.findIndex((s) => s.client === c);
    if (k < 0) return;
    if (room.state === 'playing') {
      // 對局中離開等於認輸；位子留到結算完
      const s = room.seats[k];
      s.client = null;
      s.cid = null;
      s.gone = true;
      room.game.finish(1 - k, 'disconnect');
    } else {
      room.seats.splice(k, 1);
      if (room.state === 'countdown') room.state = 'lobby';
      if (!room.seats.length) this.rooms.delete(room.code);
      else this.sendRoom(room);
    }
    this.send(c, { t: 'left' });
  }

  ready(c, on) {
    const room = c.room;
    const s = this.seatOf(c);
    if (!s || room.state === 'playing') return;
    s.ready = on;
    const all = room.seats.length === 2 && room.seats.every((x) => x.ready && x.client);
    if (room.state === 'lobby' && all) {
      room.state = 'countdown';
      room.cdEnd = this.now() + this.countdownMs;
    } else if (room.state === 'countdown' && !all) {
      room.state = 'lobby';
    }
    this.sendRoom(room);
  }

  cmd(c, raw) {
    const room = c.room;
    if (!room || room.state !== 'playing') return;
    const k = room.seats.findIndex((s) => s.client === c);
    if (k < 0) return;
    const now = this.now();
    if (now - c.cmdAt > 1000) {
      c.cmdAt = now;
      c.cmdN = 0;
    }
    if (++c.cmdN > MAX_CMDS_PER_SEC) return;
    const cmd = cleanCmd(raw);
    if (cmd) room.game.command(k, cmd);
  }

  // 連線斷了
  drop(c) {
    this.clients.delete(c);
    const room = c.room;
    if (!room) return;
    c.room = null;
    const k = room.seats.findIndex((s) => s.client === c);
    if (k < 0) return;
    if (room.state === 'playing') {
      // 對局中：位子保留一段時間等他回來
      room.seats[k].client = null;
      room.seats[k].offAt = this.now();
      this.sendNet(room);
    } else {
      room.seats.splice(k, 1);
      if (room.state === 'countdown') room.state = 'lobby';
      if (!room.seats.length) this.rooms.delete(room.code);
      else this.sendRoom(room);
    }
  }

  roomMsg(room, k) {
    return {
      t: 'room',
      code: room.code,
      open: room.open,
      state: room.state,
      you: k,
      cd: room.state === 'countdown' ? Math.max(0, Math.round(room.cdEnd - this.now())) : 0,
      players: room.seats.map((s) => ({
        name: s.name,
        char: s.char,
        ready: s.ready,
        on: !!s.client,
        rec: s.user && this.accounts ? this.accounts.info(s.user) : null,
      })),
    };
  }

  sendRoom(room) {
    room.seats.forEach((s, k) => {
      if (s.client) this.send(s.client, this.roomMsg(room, k));
    });
  }

  startMsg(room, k) {
    return { t: 'start', me: k, names: room.seats.map((s) => s.name), chars: room.seats.map((s) => s.char) };
  }

  sendNet(room) {
    const now = this.now();
    const msg = {
      t: 'net',
      rtt: room.seats.map((s) => (s.client ? s.client.rtt : -1)),
      off: room.seats.map((s) => !s.client),
      grace: room.seats.map((s) => (!s.client && s.offAt ? Math.max(0, Math.ceil((this.graceMs - (now - s.offAt)) / 1000)) : 0)),
    };
    for (const s of room.seats) if (s.client) this.send(s.client, msg);
  }

  // ---------- 對局 ----------

  startGame(room) {
    room.game = new Game((Math.random() * 0xffffffff) >>> 0, { chars: room.seats.map((s) => s.char) });
    room.state = 'playing';
    room.next = this.now() + this.tickMs;
    room.netAt = 0;
    room.seats.forEach((s, k) => {
      s.ready = false;
      s.offAt = 0;
      s.enc.reset();
      if (s.client) this.send(s.client, this.startMsg(room, k));
    });
    this.sendRoom(room);
    this.pushViews(room);
  }

  pushViews(room) {
    const g = room.game;
    room.seats.forEach((s, k) => {
      if (s.client) this.send(s.client, { t: 'view', v: s.enc.encode(makeView(g, k)) });
    });
    g.events.length = 0;
  }

  endGame(room) {
    const g = room.game;
    this.pushViews(room); // 確保雙方都收到結果
    if (this.accounts) {
      room.seats.forEach((s, k) => {
        if (s.user) this.accounts.record(s.user, g.over.winner === k ? 'win' : g.over.winner < 0 ? 'draw' : 'loss');
      });
    }
    room.game = null;
    room.state = 'lobby';
    room.seats = room.seats.filter((s) => s.client && !s.gone);
    if (!room.seats.length) {
      this.rooms.delete(room.code);
      return;
    }
    for (const s of room.seats) {
      s.ready = false;
      this.send(s.client, { t: 'me', name: s.client.name, user: this.userInfo(s.client) });
    }
    this.sendRoom(room);
  }

  // 由伺服器每隔幾十毫秒呼叫一次
  tick() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.state === 'countdown') {
        if (now >= room.cdEnd) this.startGame(room);
        continue;
      }
      if (room.state !== 'playing') continue;
      const g = room.game;
      room.seats.forEach((s, k) => {
        if (!s.client && !s.gone && now - s.offAt > this.graceMs) g.finish(1 - k, 'disconnect');
      });
      let n = 0;
      while (!g.over && now >= room.next && n < 5) {
        g.step();
        this.pushViews(room);
        room.next += this.tickMs;
        n++;
      }
      if (n === 5) room.next = now + this.tickMs; // 落後太多就不追了
      if (g.over) {
        this.endGame(room);
        continue;
      }
      if (now - room.netAt >= 1000) {
        room.netAt = now;
        this.sendNet(room);
      }
    }
    // 每 5 秒對每個連線送一次 ping，30 秒內完全沒有回應的就當作斷線清掉。
    // （不能只靠玩家端自己送的訊息：分頁放在背景時，瀏覽器會把它的計時器放得很慢。）
    if (now - this.sweepAt > 5000) {
      this.sweepAt = now;
      const limit = Date.now() - 30000;
      for (const c of [...this.clients]) {
        if (c.conn.lastSeen < limit) c.conn.close(1001);
        else c.conn.ping?.();
      }
    }
  }
}
