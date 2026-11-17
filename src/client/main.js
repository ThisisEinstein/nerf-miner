// 遊戲進入點：把模擬、電腦對手、連線、畫面、介面與玩家輸入接在一起。
// 不管是單機（這裡自己跑模擬）還是連線（伺服器跑模擬），畫面都只讀「玩家視角」view。
import { Game } from '../sim/game.js';
import { Bot } from '../ai/bot.js';
import { makeView, ViewDecoder } from '../sim/view.js';
import { W, H, C, T, TPS, MATCH_TICKS, UNKNOWN, idx, inb } from '../sim/constants.js';
import { ITEMS } from '../sim/items.js';
import { CHAR_IDS } from '../sim/chars.js';
import { Renderer } from './render.js';
import { TEAM } from './sprites.js';
import { UI, isIdle } from './ui.js';
import { Menu } from './menu.js';
import { Net } from './net.js';
import { audio } from './audio.js';

const TICK_MS = 100;
const LEVEL_NAME = { easy: '簡單', normal: '普通', hard: '困難' };
const FX_SOUND = { coin: 'coin', boom: 'boom', laser: 'laser', hit: 'hit', death: 'death', freeze: 'freeze', capture: 'capture', spike: 'spike', snuff: 'snuff' };
// 可以「瞄準使用」的道具：作用範圍的形狀與預覽顏色
const AIM = {
  laser: { shape: 'diamond', r: C.laserRange, rgb: '255,90,70' },
  spike: { shape: 'square', r: 0, rgb: '200,205,220' },
  portal: { shape: 'square', r: 0, rgb: '170,110,255' },
  fake: { shape: 'square', r: 1, rgb: '255,217,138' },
  hard: { shape: 'square', r: 2, rgb: '190,180,170' },
  mud: { shape: 'square', r: 2, rgb: '170,120,70' },
  snuff: { shape: 'diamond', r: C.snuffRange, rgb: '170,170,170' },
  spell: { shape: 'diamond', r: C.spellRange, rgb: '140,220,255' },
  tnt: { shape: 'blast', rgb: '255,120,60' },
};
const canvas = document.getElementById('view');
const mini = document.getElementById('mini');
const R = new Renderer(canvas);
const seed = () => (Math.random() * 0xffffffff) >>> 0;
const randomChar = () => CHAR_IDS[Math.floor(Math.random() * CHAR_IDS.length)];

let mode = null; // 'solo' | 'net' | null（在選單）
let view = null; // 目前的玩家視角
let viewAt = 0; // 收到這份視角的時間
let me = 0;
let names = ['你', '電腦'];
let game = null; // 單機：自己跑的模擬
let bot = null;
let soloCfg = null;
let decoder = null; // 連線：解開伺服器送來的差異
let netInfo = { rtt: [-1, -1], off: [false, false], grace: [0, 0] };
let demo = null; // 選單背景的示範對局
let started = false; // 這一局已經拿到第一份視角
let running = false; // 對局進行中（還沒分出勝負）
let sel = []; // 選取中的礦工編號，第一個是主要的那個
let aim = null; // 正在瞄準使用道具：{ item, id, fetch }
let hover = null;
let acc = 0;
let last = performance.now();
let frameNo = 0;
let sellArmed = null;
let lastDug = 0;
let lastLit = 0;
let lastSec = -1;
let hadZone = false; // 上一份視角裡有沒有概略情報的範圍
let hadSure = false; // 上一份視角裡有沒有已確認的敵方的家
const keys = new Set();
const pending = [];

const net = new Net({ msg: onNet, state: onNetState });
const menu = new Menu({ net, sprites: R.sp, onSolo: startSolo });
const ui = new UI(
  {
    buy,
    stock: fetchItem,
    select: (id, add) => {
      if (add) toggleSel(id);
      else {
        if (sel[0] === id && sel.length === 1) focusMiner();
        sel = [id];
      }
    },
    minerAct,
    emote: (id) => send({ type: 'emote', id }),
    taunt: () => send({ type: 'taunt' }),
    tauntAnswer: (yes) => send(yes ? { type: 'surrender' } : { type: 'emote', id: 'no' }),
    surrender: () => send({ type: 'surrender' }),
    map: toggleMap,
    again,
    exit,
  },
  R.sp,
);

// ---------- 開始與結束 ----------

function send(cmd) {
  if (!running) return;
  if (mode === 'solo') game.command(me, cmd);
  else if (mode === 'net') net.send({ t: 'cmd', c: cmd });
}

function own() {
  return view ? view.miners.filter((m) => m.team === me) : [];
}

// 選取中而且活著的礦工（照選取順序）
function selMiners() {
  const list = own();
  return sel.map((id) => list.find((m) => m.id === id)).filter((m) => m && m.state !== 'fountain');
}

function primary() {
  return selMiners()[0] || null;
}

function toggleSel(id) {
  if (sel.includes(id)) {
    if (sel.length > 1) sel = sel.filter((x) => x !== id);
  } else sel = [...sel, id];
}

function startSolo(level, char) {
  demo = null;
  game = new Game(seed(), { chars: [char, randomChar()] });
  bot = new Bot(game, 1, level);
  soloCfg = { level, char };
  mode = 'solo';
  me = 0;
  names = [menu.displayName() || '你', `電腦（${LEVEL_NAME[level] || level}）`];
  pending.length = 0;
  acc = 0;
  view = makeView(game, me);
  game.events.length = 0;
  viewAt = performance.now();
  begin();
}

// 這個分頁正在打連線對局的記號：重新整理頁面後靠它自動連回去
const live = (on) => {
  try {
    if (on) sessionStorage.setItem('nm_live', '1');
    else sessionStorage.removeItem('nm_live');
  } catch {
    // 不能存就算了
  }
};

function startNet(m) {
  live(true);
  demo = null;
  game = null;
  bot = null;
  mode = 'net';
  me = m.me === 1 ? 1 : 0;
  names = [String(m.names?.[0] ?? '玩家 1'), String(m.names?.[1] ?? '玩家 2')];
  decoder = new ViewDecoder();
  view = null;
  started = false;
  running = false;
  netInfo = { rtt: [-1, -1], off: [false, false], grace: [0, 0] };
}

// 拿到這一局的第一份視角之後：切到對局畫面
function begin() {
  menu.inGame = true;
  menu.show(null);
  R.reset(me);
  R.setView(view);
  document.documentElement.style.setProperty('--me', TEAM[me].main);
  document.documentElement.style.setProperty('--foe', TEAM[1 - me].main);
  ui.start({ me, names, priceMul: view.priceMul, avatar: menu.avatar(me, view.chars[me]), online: mode === 'net' });
  R.map = false;
  syncLayout();
  const hm = myHome();
  if (hm) R.centerOn(hm.cx, hm.cy);
  sel = own()[0] ? [own()[0].id] : [];
  aim = null;
  started = true;
  running = !view.over;
  lastDug = view.dug;
  lastLit = view.litCount;
  lastSec = -1;
  hadZone = !!view.intelZone;
  hadSure = view.homes.some((h) => h.sure);
  audio.intense = false;
  audio.play('start');
  audio.startMusic();
  if (view.tick < 5) ui.banner('開始！選礦工，再點地圖讓他挖過去');
}

function myHome() {
  return view ? view.homes.find((h) => h.team === me && !h.fake) || null : null;
}

function finish() {
  running = false;
  cancelAim();
  ui.update(view, sel, R.map);
  ui.showOver(view, { online: mode === 'net' });
  ui.netWarn('');
  audio.stopMusic();
  audio.play(view.over.winner === me ? 'win' : view.over.winner < 0 ? 'announce' : 'lose');
  if (mode === 'net') overStatus();
}

// 連線時結算畫面下方的狀態：要雙方都按「再來一局」才會開始
function overStatus() {
  const r = menu.room;
  const mine = r && r.players[r.you];
  const other = r && r.players[1 - r.you];
  if (!mine || !other) ui.overStatus('對手已經離開了。', false, false);
  else if (r.state === 'countdown') ui.overStatus('馬上開始下一局！', true);
  else if (mine.ready) ui.overStatus('等對手也按「再來一局」…', true);
  else if (other.ready) ui.overStatus('對手想再來一局！', false);
  else ui.overStatus('', false);
}

function again() {
  if (mode === 'solo') startSolo(soloCfg.level, soloCfg.char);
  else if (mode === 'net') {
    const r = menu.room;
    if (r && r.players[r.you]) net.send({ t: 'ready', on: !r.players[r.you].ready });
  }
}

function exit() {
  if (mode === 'net') net.send({ t: 'leave' });
  toMenu(mode === 'net' ? 'lobby' : 'menu');
}

function toMenu(screen) {
  const wasNet = mode === 'net';
  live(false);
  mode = null;
  running = false;
  started = false;
  game = null;
  bot = null;
  view = null;
  aim = null;
  audio.stopMusic();
  ui.hide();
  menu.inGame = false;
  if (wasNet && screen === 'lobby') {
    menu.room = null;
    net.send({ t: 'top' });
  }
  menu.show(screen);
  startDemo();
}

// ---------- 選單背景：兩個電腦自己打的一局 ----------

function startDemo() {
  const g = new Game(seed(), { chars: [randomChar(), randomChar()] });
  demo = { game: g, bots: [new Bot(g, 0, 'normal'), new Bot(g, 1, 'normal')], acc: 0, focus: null, focusAt: 0 };
  R.reset(0);
  R.inset = { l: 0, t: 0, r: 0, b: 0 };
  R.map = false;
  R.resize();
  R.setView(makeView(g, 0));
  const hm = g.homes[0];
  R.centerOn(hm.cx + 4, hm.cy);
}

function stepDemo(dt, now) {
  demo.acc += dt;
  let n = 0;
  while (demo.acc >= TICK_MS && n < 3) {
    demo.acc -= TICK_MS;
    n++;
    for (const b of demo.bots) b.update();
    demo.game.step();
    const v = makeView(demo.game, 0);
    demo.game.events.length = 0;
    R.setView(v);
    for (const e of v.events) if (e.type === 'fx') R.addFx(e);
    if (demo.game.over) return startDemo();
  }
  if (n === 3) demo.acc = 0;
  // 鏡頭慢慢跟著其中一名礦工，每隔幾秒換一個
  const v = R.v;
  const list = v.miners.filter((m) => m.team === 0 && m.state !== 'fountain');
  if (!list.length) return;
  if (now - demo.focusAt > 9000 || !list.some((m) => m.id === demo.focus)) {
    demo.focus = list[Math.floor(Math.random() * list.length)].id;
    demo.focusAt = now;
  }
  const f = list.find((m) => m.id === demo.focus);
  const c = R.viewCenter;
  const k = 1 - Math.pow(0.25, dt / 1000);
  R.cam.x += ((f.x + 0.5) * R.T - c.x - R.cam.x) * k;
  R.cam.y += ((f.y + 0.5) * R.T - c.y - R.cam.y) * k;
  R.clamp();
}

// ---------- 每個 tick ----------

function tickSolo() {
  bot.update();
  game.step();
  for (let k = pending.length - 1; k >= 0; k--) {
    if (pending[k].at <= game.tick) pending.splice(k, 1)[0].fn();
  }
  view = makeView(game, me);
  game.events.length = 0;
  viewAt = performance.now();
  onView();
}

// 每拿到一份新的視角
function onView() {
  R.setView(view);
  handleEvents(view.events);
  if (view.dug > lastDug) audio.play('dig');
  lastDug = view.dug;
  if (view.litCount > lastLit) audio.play('torch');
  lastLit = view.litCount;
  const sec = Math.ceil((MATCH_TICKS - view.tick) / TPS);
  if (sec !== lastSec) {
    lastSec = sec;
    if (sec <= 10 && sec > 0 && running) audio.play('tick');
    audio.intense = sec <= 60;
  }
  // 情報剛生效：用橫幅和地圖上的閃爍告訴玩家標在哪裡
  const z = view.intelZone;
  if (z && !hadZone) {
    ui.banner('概略情報：敵方的家在紅框範圍裡（小地圖上也有標）');
    R.addFx({ kind: 'alert', x: z.x + (z.w >> 1), y: z.y + (z.h >> 1) });
    audio.play('announce');
  }
  hadZone = !!z;
  const sure = view.homes.find((h) => h.sure);
  if (sure && !hadSure) {
    ui.banner('精確情報：敵方的家已標在地圖上');
    R.addFx({ kind: 'alert', x: sure.cx, y: sure.cy });
    audio.play('announce');
  }
  hadSure = !!sure;
  // 選取名單裡只留還在的礦工
  const ids = new Set(own().map((m) => m.id));
  sel = sel.filter((id) => ids.has(id));
  if (!sel.length && own().length) sel = [own()[0].id];
  if (view.over && running) finish();
}

function handleEvents(ev) {
  for (const e of ev) {
    if (e.type === 'msg') {
      ui.log(e.text, e.kind);
      if (e.kind === 'alert') {
        ui.banner(e.text, 'alert');
        if (Number.isInteger(e.x)) R.addFx({ kind: 'alert', x: e.x, y: e.y });
        audio.play('alert');
      } else if (e.kind === 'bad') audio.play('bad');
      else if (e.kind === 'good') audio.play('good');
    } else if (e.type === 'announce') {
      ui.banner(e.text);
      ui.log(e.text, 'info');
      audio.play('announce');
    } else if (e.type === 'vision') {
      const a = e.lit[me];
      const b = e.lit[1 - me];
      const p = Math.round((a / Math.max(1, a + b)) * 100);
      const text = `4 分鐘：視野佔比　你 ${p}% ： 對手 ${100 - p}%`;
      ui.banner(text);
      ui.log(text, 'info');
      audio.play('announce');
    } else if (e.type === 'fx') {
      R.addFx(e);
      if (FX_SOUND[e.kind]) audio.play(FX_SOUND[e.kind]);
    } else if (e.type === 'emote') {
      ui.emote(e.team === me, e.id);
      audio.play('pop');
    } else if (e.type === 'taunt') {
      audio.play('pop');
      if (e.team === me) {
        ui.emote(true, 'ask');
        // 單機時電腦過一下會回「才不要！」
        if (mode === 'solo') pending.push({ at: game.tick + 15, fn: () => game.command(1 - me, { type: 'emote', id: 'no' }) });
      } else {
        ui.emote(false, 'ask');
        ui.showTaunt();
      }
    }
  }
}

// ---------- 連線 ----------

function onNet(m) {
  switch (m.t) {
    case 'welcome':
      // 伺服器如果還留著位子，緊接著會送 start，記號會再設回來
      live(false);
      menu.onMsg(m);
      break;
    case 'start':
      startNet(m);
      break;
    case 'view':
      if (mode !== 'net' || !decoder) break;
      view = decoder.decode(m.v);
      viewAt = performance.now();
      if (!started) begin();
      onView();
      break;
    case 'net':
      if (Array.isArray(m.rtt) && Array.isArray(m.off) && Array.isArray(m.grace)) netInfo = m;
      break;
    case 'room':
      menu.onMsg(m);
      if (mode === 'net' && started && !running) overStatus();
      break;
    default:
      menu.onMsg(m);
  }
}

function onNetState(s) {
  menu.onNetState(s);
  // 結算畫面上斷線：房間已經不在了，回大廳
  if (s === 'off' && mode === 'net' && started && !running) toMenu('lobby');
}

function netStatus(now) {
  const lag = now - viewAt;
  ui.net(net.rtt, netInfo.rtt[1 - me] ?? -1, lag);
  if (!running) return;
  let warn = '';
  if (net.state !== 'on') warn = '連線中斷，正在重新連線…';
  else if (netInfo.off[1 - me]) warn = `對手斷線了，等他回來…（${netInfo.grace[1 - me]} 秒內沒回來就算你贏）`;
  else if (lag > 1500) warn = '網路延遲中，畫面暫時停住…';
  ui.netWarn(warn);
}

// ---------- 操作 ----------

function syncLayout() {
  R.inset = ui.insets();
  R.resize();
  // 小地圖：用整數倍放大，一格 3 個左右的螢幕像素
  const px = Math.max(2, Math.round(3 * R.dpr)) * W;
  if (mini.width !== px) {
    mini.width = px;
    mini.height = Math.round((px * H) / W);
  }
  mini.style.width = `${px / R.dpr}px`;
  mini.style.height = `${mini.height / R.dpr}px`;
}

function toggleMap() {
  if (!started) return;
  R.setMap(!R.map);
  if (!R.map) focusMiner();
}

function focusMiner() {
  const m = primary();
  const hm = myHome();
  if (m) R.centerOn(m.x, m.y);
  else if (hm) R.centerOn(hm.cx, hm.cy);
}

// 買道具；fetch 表示順便叫選取的礦工回家拿
function buy(item, fetch) {
  send({ type: 'buy', item });
  audio.play('click');
  if (fetch && Object.hasOwn(ITEMS, item) && !ITEMS[item].instant) fetchItem(item, true);
}

// 叫主要選取的礦工回家拿某個道具；能放置的道具會接著讓玩家選要放在哪
function fetchItem(item, justBought = false) {
  const m = primary();
  if (!m) return ui.log('先選一名活著的礦工，再點庫存裡的道具。', 'bad');
  if (!justBought && !view.stock.includes(item)) return;
  send({ type: 'pickup', minerId: m.id, item });
  audio.play('click');
  if (AIM[item] && item !== 'tnt') startAim(m, item, true);
}

function startAim(m, item, fetch) {
  aim = { item, id: m.id, fetch, since: performance.now() };
  const name = ITEMS[item].name;
  ui.hint(
    item === 'tnt'
      ? `<b>${name}</b>：移動滑鼠選方向，點一下引爆 · <kbd>Esc</kbd> 取消`
      : fetch
        ? `<b>${name}</b>：點地圖選要放在哪，礦工拿到之後會自己走過去使用 · <kbd>Esc</kbd> 先不放（之後按 <kbd>E</kbd>）`
        : `<b>${name}</b>：點地圖選位置，礦工會走過去使用 · 再按 <kbd>E</kbd> 在原地使用 · <kbd>Esc</kbd> 取消`,
  );
}

function cancelAim() {
  aim = null;
  ui.hint('');
}

// 按 E：開始瞄準；已經在瞄準就直接在原地使用
function useKey() {
  const m = aim ? own().find((x) => x.id === aim.id) : primary();
  if (!m) return ui.log('先選一名活著的礦工。', 'bad');
  if (aim) {
    if (!aim.fetch) {
      if (aim.item === 'tnt') {
        const d = blastDir(m);
        send({ type: 'use', minerId: m.id, dx: d[0], dy: d[1] });
      } else send({ type: 'use', minerId: m.id });
      audio.play('click');
    }
    return cancelAim();
  }
  const item = m.carry && m.carry !== 'bomb' ? m.carry : m.fetch;
  if (!item || !AIM[item]) return ui.log(m.carry === 'bomb' ? '炸彈不用按：走進敵方的家就會爆。' : '這名礦工手上沒有可以用的道具。', 'bad');
  if (item === 'tnt' && !m.carry) return ui.log('等礦工拿到 TNT 再按 E 選方向。', 'info');
  startAim(m, item, !m.carry);
}

// TNT 的方向：從礦工指向滑鼠所在的格子，取比較長的那個軸
function blastDir(m) {
  if (hover) {
    const dx = hover.x - m.x;
    const dy = hover.y - m.y;
    if (dx || dy) return Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
  }
  return [m.dx < 0 ? -1 : 1, 0];
}

// 瞄準時要在地圖上標出來的格子
function previewTiles() {
  const m = own().find((x) => x.id === aim.id);
  const a = AIM[aim.item];
  if (!m || !a) return null;
  const tiles = [];
  const add = (x, y) => {
    if (inb(x, y)) tiles.push(idx(x, y));
  };
  if (a.shape === 'blast') {
    const [fx, fy] = blastDir(m);
    for (let d = 1; d <= 4; d++) for (let l = -1; l <= 1; l++) add(m.x + fx * d - fy * l, m.y + fy * d + fx * l);
  } else {
    const c = hover && inb(hover.x, hover.y) ? hover : m;
    for (let dy = -a.r; dy <= a.r; dy++) {
      for (let dx = -a.r; dx <= a.r; dx++) {
        if (a.shape === 'diamond' && Math.abs(dx) + Math.abs(dy) > a.r) continue;
        add(c.x + dx, c.y + dy);
      }
    }
  }
  return { tiles, rgb: a.rgb };
}

// 瞄準中點了地圖
function aimClick(t) {
  const m = own().find((x) => x.id === aim.id);
  if (!m || !inb(t.x, t.y)) return cancelAim();
  if (aim.item === 'tnt') {
    const d = blastDir(m);
    send({ type: 'use', minerId: m.id, dx: d[0], dy: d[1] });
  } else if (!aim.fetch && t.x === m.x && t.y === m.y) {
    send({ type: 'use', minerId: m.id });
  } else {
    if (view.know[idx(t.x, t.y)] === T.ROCK) {
      audio.play('bad');
      return ui.log('石頭上不能放，換個地方。', 'bad');
    }
    send({ type: 'move', minerId: m.id, x: t.x, y: t.y, use: true, queue: aim.fetch });
    R.addFx({ kind: 'order', x: t.x, y: t.y });
  }
  audio.play('order');
  cancelAim();
}

function minerAct(act, id) {
  const m = own().find((x) => x.id === id);
  const hm = myHome();
  if (!m) return;
  if (!sel.includes(id)) sel = [id];
  if (act === 'use') {
    sel = [id, ...sel.filter((x) => x !== id)];
    cancelAim();
    useKey();
  } else if (act === 'up') send({ type: 'upgrade', minerId: id });
  else if (act === 'home' && hm) send({ type: 'move', minerId: id, x: hm.cx, y: hm.cy });
  else if (act === 'stop') send({ type: 'stop', minerId: id });
  else if (act === 'auto') {
    send({ type: 'auto', minerId: id, on: !m.auto });
    audio.play('click');
  } else if (act === 'sell') {
    if (sellArmed && sellArmed.id === id && performance.now() - sellArmed.t < 3000) {
      sellArmed = null;
      send({ type: 'sell', minerId: id });
    } else {
      sellArmed = { id, t: performance.now() };
      ui.log('再按一次「賣」確定賣掉這名礦工。', 'info');
    }
  }
}

// 對所有選取中的礦工下同一個指令
function forSel(fn) {
  const list = selMiners();
  if (!list.length) ui.log('先選一名活著的礦工。', 'bad');
  for (const m of list) fn(m);
  return list.length;
}

function order(t, queue) {
  if (!inb(t.x, t.y)) return;
  if (view.know[idx(t.x, t.y)] === T.ROCK) {
    audio.play('bad');
    return ui.log('石頭不能挖，換個地方。', 'bad');
  }
  if (!forSel((m) => send({ type: 'move', minerId: m.id, x: t.x, y: t.y, queue }))) return;
  R.addFx({ kind: 'order', x: t.x, y: t.y });
  audio.play('order');
}

function clickTile(t, shift) {
  if (aim) return aimClick(t);
  const here = own().filter((m) => {
    if (m.state === 'fountain') return false;
    const p = R.minerPos(m, 0);
    return Math.round(p.x) === t.x && Math.round(p.y) === t.y;
  });
  if (here.length) {
    if (shift) toggleSel(here[0].id);
    else {
      // 同一格站了好幾個：每點一下換下一個
      const k = here.findIndex((m) => m.id === sel[0]);
      sel = [here[(k + 1) % here.length].id];
    }
    audio.play('click');
    return;
  }
  order(t, shift);
}

function describe(t) {
  if (!view || !inb(t.x, t.y)) return '';
  const i = idx(t.x, t.y);
  const k = view.know[i];
  let s =
    k === UNKNOWN
      ? '還沒探索'
      : k === T.DIRT
        ? view.ore[i]
          ? '金礦脈（挖了 +$15）'
          : '土'
        : k === T.HARD
          ? view.ore[i]
            ? '硬土裡的金礦脈'
            : '硬土（挖很久）'
          : k === T.ROCK
            ? '石頭（不能挖）'
            : '通道';
  const mn = view.mines.find((q) => q.x === t.x && q.y === t.y);
  if (mn) s = `${mn.neutral ? '中立礦井' : '礦井'}（${mn.owner === me ? '你的' : mn.owner < 0 ? '沒人佔領' : '敵方的'}）· 站上去 3 秒佔領`;
  if (!view.treasure.taken && view.treasure.x === t.x && view.treasure.y === t.y) s = '大寶藏 · 站上去 8 秒搶下（$80 + 一個假的家）';
  const h = view.homes.find((q) => Math.abs(q.cx - t.x) <= 1 && Math.abs(q.cy - t.y) <= 1);
  if (h) s = h.team === me ? (h.fake ? '你的假的家' : '你的家') : '敵方的家 · 帶炸彈走進去就獲勝';
  return `(${t.x}, ${t.y}) ${s}`;
}

function moveCamera(dt) {
  const sp = (dt / 1000) * 700;
  let dx = 0;
  let dy = 0;
  if (keys.has('a') || keys.has('arrowleft')) dx -= sp;
  if (keys.has('d') || keys.has('arrowright')) dx += sp;
  if (keys.has('w') || keys.has('arrowup')) dy -= sp;
  if (keys.has('s') || keys.has('arrowdown')) dy += sp;
  if (dx || dy) R.panBy(dx, dy);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(250, now - last);
  last = now;
  frameNo++;
  let alpha = 1;
  if (mode === 'solo') {
    if (running) {
      moveCamera(dt);
      acc += dt;
      let steps = 0;
      while (acc >= TICK_MS && steps < 5 && running) {
        tickSolo();
        acc -= TICK_MS;
        steps++;
      }
      if (steps === 5) acc = 0;
      alpha = Math.min(1, acc / TICK_MS);
    }
  } else if (mode === 'net') {
    if (running) moveCamera(dt);
    alpha = Math.min(1, (now - viewAt) / TICK_MS);
  } else if (demo) {
    stepDemo(dt, now);
    alpha = Math.min(1, demo.acc / TICK_MS);
  }
  const inGame = mode && started && view;
  if (inGame && aim) {
    // 礦工倒下或道具不在了：結束瞄準。剛下「回家拿」的指令時畫面還沒更新，所以先等一下再檢查
    const m = own().find((x) => x.id === aim.id);
    const has = m && (m.carry === aim.item || m.fetch === aim.item);
    if (!m || m.state === 'fountain' || (!has && now - aim.since > 1500)) cancelAim();
    else if (aim.fetch && m.carry === aim.item) aim.fetch = false;
  }
  R.draw(alpha, inGame ? { sel, hover, preview: aim ? previewTiles() : null } : { sel: [], hover: null, preview: null });
  if (inGame) {
    if (running) {
      ui.update(view, sel, R.map);
      ui.tip(hover ? describe(hover) : '');
    }
    // 大地圖模式本身就是整張地圖，不需要小地圖
    mini.classList.toggle('hidden', R.map);
    if (!R.map && frameNo % 3 === 0) R.drawMini(mini);
    if (mode === 'net') netStatus(now);
  }
}

// ---------- 輸入 ----------

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!started) return;
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, cx: R.cam.x, cy: R.cam.y, moved: false, button: e.button };
});
canvas.addEventListener('pointermove', (e) => {
  if (!started) return;
  hover = R.tileAt(e.clientX, e.clientY);
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
  if (drag.moved) {
    R.cam.x = drag.cx - dx * R.dpr;
    R.cam.y = drag.cy - dy * R.dpr;
    R.clamp();
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!started || !drag) return;
  const d = drag;
  drag = null;
  if (d.moved || !running) return;
  const t = R.tileAt(e.clientX, e.clientY);
  if (d.button === 2) {
    if (aim) cancelAim();
    else order(t, e.shiftKey);
  } else if (d.button === 0) clickTile(t, e.shiftKey);
});
canvas.addEventListener('pointerleave', () => {
  hover = null;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener(
  'wheel',
  (e) => {
    if (!started) return;
    e.preventDefault();
    R.zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
  },
  { passive: false },
);

// 小地圖：點一下或拖曳，把鏡頭移過去
function miniJump(e) {
  if (!started) return;
  const b = mini.getBoundingClientRect();
  R.centerOn(Math.floor(((e.clientX - b.left) / b.width) * W), Math.floor(((e.clientY - b.top) / b.height) * H));
}
mini.addEventListener('pointerdown', (e) => {
  mini.setPointerCapture(e.pointerId);
  miniJump(e);
});
mini.addEventListener('pointermove', (e) => {
  if (e.buttons) miniJump(e);
});

window.addEventListener('keydown', (e) => {
  if (!running || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) {
    keys.add(k);
    e.preventDefault();
    return;
  }
  if (e.repeat) return;
  const list = own();
  const digit = /^Digit[1-5]$/.test(e.code) ? Number(e.code.slice(5)) : 0;
  if (digit) {
    const m = list[digit - 1];
    if (!m) return;
    if (e.shiftKey) toggleSel(m.id);
    else {
      if (sel[0] === m.id && sel.length === 1) focusMiner();
      sel = [m.id];
    }
  } else if (k === 'tab') {
    e.preventDefault();
    const i = list.findIndex((m) => m.id === sel[0]);
    if (list.length) sel = [list[(i + 1) % list.length].id];
  } else if (k === 'q') {
    // 跳到下一個閒著的礦工
    const idle = list.filter((m) => isIdle(m, view));
    if (!idle.length) return ui.log('沒有閒著的礦工。', 'info');
    const i = idle.findIndex((m) => m.id === sel[0]);
    sel = [idle[(i + 1) % idle.length].id];
    focusMiner();
  } else if (k === 'f') {
    const all = list.filter((m) => m.state !== 'fountain').map((m) => m.id);
    if (all.length) sel = all;
  } else if (k === 'e') {
    useKey();
  } else if (k === 'u') {
    if (primary()) send({ type: 'upgrade', minerId: primary().id });
  } else if (k === 'h') {
    const hm = myHome();
    if (hm) forSel((m) => send({ type: 'move', minerId: m.id, x: hm.cx, y: hm.cy }));
  } else if (k === 'x') {
    forSel((m) => send({ type: 'stop', minerId: m.id }));
  } else if (k === 'g') {
    // 選取的礦工一起開或一起關自動探索
    const p = primary();
    if (p) {
      forSel((m) => send({ type: 'auto', minerId: m.id, on: !p.auto }));
      ui.log(p.auto ? '關掉自動探索。' : '開啟自動探索：沒事做的時候會自己找地方挖。', 'info');
    }
  } else if (k === 'b') {
    if (view.stock.includes('bomb')) fetchItem('bomb');
    else ui.log('家裡沒有炸彈，先到商店買。', 'bad');
  } else if (k === 'm') {
    toggleMap();
  } else if (k === 'escape') {
    if (aim) cancelAim();
    else if (sel.length > 1) sel = [sel[0]];
    document.getElementById('help').classList.add('hidden');
  } else if (k === ' ') {
    e.preventDefault();
    focusMiner();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
window.addEventListener('resize', () => {
  if (mode && started) syncLayout();
  else R.resize();
});
// 瀏覽器要使用者先點過畫面才准出聲
window.addEventListener('pointerdown', () => audio.unlock(), true);
window.addEventListener('keydown', () => audio.unlock(), true);

// 開發與測試用：在瀏覽器主控台可以用 __nm 觀察狀態。
window.__nm = {
  get view() {
    return view;
  },
  get game() {
    return game;
  },
  get mode() {
    return mode;
  },
  get running() {
    return running;
  },
  get sel() {
    return sel;
  },
  get aim() {
    return aim;
  },
  R,
  net,
  menu,
  startSolo,
  // 單機時快轉 n 個 tick
  step(n = 1) {
    for (let k = 0; k < n && mode === 'solo' && running; k++) tickSolo();
    if (view && started) ui.update(view, sel, R.map);
  },
};

startDemo();
requestAnimationFrame(frame);
// 對局中重新整理了頁面：自動連回伺服器，位子還在的話會直接接著打
try {
  if (sessionStorage.getItem('nm_live')) net.connect();
} catch {
  // 讀不到就照一般流程
}
