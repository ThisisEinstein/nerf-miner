// 伺服器的測試：WebSocket 編解碼、帳號、以及兩個玩家真的連上來打一局。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { acceptKey, encodeFrame, FrameParser, attachWebSocket } from '../src/server/ws.js';
import { Accounts } from '../src/server/accounts.js';
import { Lobby, cleanCmd } from '../src/server/lobby.js';
import { ViewDecoder } from '../src/sim/view.js';

test('WebSocket：握手金鑰與 frame 編解碼', () => {
  // RFC 6455 裡的範例
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const mask = Buffer.from([1, 2, 3, 4]);
  for (const len of [0, 5, 125, 126, 300, 65535, 65536, 70000]) {
    const text = 'x'.repeat(len);
    const wire = encodeFrame(text, 1, mask);
    const p = new FrameParser(1 << 20);
    // 拆成零碎的小塊餵進去
    const out = [];
    for (let i = 0; i < wire.length; i += 777) out.push(...p.push(wire.subarray(i, i + 777)));
    assert.equal(out.length, 1, `長度 ${len}`);
    assert.equal(out[0].opcode, 1);
    assert.equal(out[0].payload.toString(), text);
  }
  const p = new FrameParser();
  const two = Buffer.concat([encodeFrame('你好', 1, mask), encodeFrame('世界', 1, mask)]);
  assert.deepEqual(
    p.push(two).map((f) => f.payload.toString()),
    ['你好', '世界'],
  );
  assert.throws(() => new FrameParser().push(encodeFrame('沒有遮罩')), /unmasked/);
  assert.throws(() => new FrameParser(100).push(encodeFrame('y'.repeat(200), 1, mask)), /too big/);
});

test('指令過濾：只放行認得的欄位', () => {
  assert.deepEqual(cleanCmd({ type: 'move', minerId: 1, x: 3, y: 4, extra: 'x' }), { type: 'move', minerId: 1, x: 3, y: 4, queue: false, use: false });
  assert.equal(cleanCmd({ type: 'move', minerId: 1, x: '3', y: 4 }), null);
  assert.equal(cleanCmd({ type: 'buy', item: '__proto__' }), null);
  assert.equal(cleanCmd({ type: 'buy', item: 'nope' }), null);
  assert.deepEqual(cleanCmd({ type: 'buy', item: 'laser' }), { type: 'buy', item: 'laser' });
  assert.equal(cleanCmd({ type: 'emote', id: '<img src=x onerror=alert(1)>' }), null);
  assert.deepEqual(cleanCmd({ type: 'emote', id: 'cry' }), { type: 'emote', id: 'cry' });
  assert.equal(cleanCmd({ type: 'finish' }), null);
  assert.equal(cleanCmd(null), null);
});

test('帳號：註冊、登入、憑證、戰績、存檔', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nerf-acc-'));
  const file = path.join(dir, 'accounts.json');
  try {
    const acc = new Accounts(file);
    assert.equal((await acc.register('a', 'secret-pass')).ok, false, '名字太短');
    assert.equal((await acc.register('阿土', '123')).ok, false, '密碼太短');
    const r = await acc.register('阿土', 'secret-pass');
    assert.ok(r.ok && r.token);
    assert.equal((await acc.register('阿土', 'another-pass')).ok, false, '名字不能重複');
    assert.equal((await acc.register('__proto__', 'secret-pass')).ok, true, '奇怪的名字也只是一個名字');
    assert.equal((await acc.login('阿土', 'wrong-pass')).ok, false);
    const l = await acc.login('阿土', 'secret-pass');
    assert.ok(l.ok && l.token !== r.token);
    assert.equal(acc.byToken(r.token).name, '阿土');
    assert.equal(acc.byToken('不存在'), null);
    acc.record('阿土', 'win');
    acc.record('阿土', 'win');
    acc.record('阿土', 'loss');
    assert.deepEqual(acc.info('阿土'), { name: '阿土', wins: 2, losses: 1, draws: 0 });
    assert.equal(acc.top(10)[0].name, '阿土');
    acc.logout(l.token);
    assert.equal(acc.byToken(l.token), null);
    await acc.flush();
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('secret-pass') && !raw.includes(r.token), '檔案裡不能有明碼或憑證本身');
    // 重新載入後資料還在
    const again = new Accounts(file);
    assert.equal(again.byToken(r.token).name, '阿土');
    assert.equal((await again.login('阿土', 'secret-pass')).ok, true);
    assert.equal(again.info('阿土').wins, 2);
    // 連續猜錯會被暫時擋下
    for (let k = 0; k < 8; k++) await again.login('阿土', 'guess-' + k, '9.9.9.9');
    assert.match((await again.login('阿土', 'secret-pass', '9.9.9.9')).error, /太多次/);
    assert.equal((await again.login('阿土', 'secret-pass', '1.1.1.1')).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 兩個玩家真的連線打一局 ----------

function startServer(opts = {}) {
  const accounts = new Accounts(null);
  const lobby = new Lobby({ accounts, version: 'test', graceMs: 250, countdownMs: 30, tickMs: 10, ...opts });
  const server = http.createServer((req, res) => res.end('ok'));
  attachWebSocket(server, '/ws', (conn) => lobby.connect(conn));
  const timer = setInterval(() => lobby.tick(), 3);
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      ok({
        lobby,
        accounts,
        url: `ws://127.0.0.1:${server.address().port}/ws`,
        close: () => {
          clearInterval(timer);
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

function player(url, hello = {}) {
  const ws = new WebSocket(url);
  const p = { ws, msgs: [], view: null, dec: new ViewDecoder(), waiters: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'view') p.view = p.dec.decode(m.v);
    p.msgs.push(m);
    p.waiters = p.waiters.filter((w) => !w());
  };
  p.send = (o) => ws.send(JSON.stringify(o));
  // 等到出現符合條件的訊息（包含已經收到的）
  p.wait = (pred, ms = 4000) =>
    new Promise((ok, no) => {
      const found = () => p.msgs.find(pred);
      if (found()) return ok(found());
      const timer = setTimeout(() => no(new Error('等不到訊息：' + pred)), ms);
      p.waiters.push(() => {
        const m = found();
        if (!m) return false;
        clearTimeout(timer);
        ok(m);
        return true;
      });
    });
  p.ready = new Promise((ok, no) => {
    ws.onopen = () => {
      p.send({ t: 'hello', ...hello });
      ok(p);
    };
    ws.onerror = () => no(new Error('連不上'));
  });
  return p;
}

async function seated(s) {
  const a = await player(s.url, { cid: 'aaaaaaaa1111', name: '小明' }).ready;
  const b = await player(s.url, { cid: 'bbbbbbbb2222', name: '小華' }).ready;
  await a.wait((m) => m.t === 'welcome');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'create' });
  const room = await a.wait((m) => m.t === 'room');
  b.send({ t: 'join', code: room.code });
  await a.wait((m) => m.t === 'room' && m.players.length === 2);
  return { a, b, code: room.code };
}

async function playing(s) {
  const { a, b, code } = await seated(s);
  a.send({ t: 'char', id: 'scout' });
  a.send({ t: 'ready', on: true });
  b.send({ t: 'ready', on: true });
  const sa = await a.wait((m) => m.t === 'start');
  const sb = await b.wait((m) => m.t === 'start');
  assert.equal(sa.me, 0);
  assert.equal(sb.me, 1);
  assert.deepEqual(sa.names, ['小明', '小華']);
  assert.deepEqual(sa.chars, ['scout', 'digger']);
  await a.wait((m) => m.t === 'view' && m.v.tick >= 3);
  await b.wait((m) => m.t === 'view' && m.v.tick >= 3);
  return { a, b, code };
}

test('連線對戰：建房、加入、準備、下指令、認輸、戰績', async () => {
  const s = await startServer();
  try {
    const { a, b } = await playing(s);
    // 註冊之後才開的房間不在這裡測；這裡先確認視角沒有外流
    assert.equal(a.view.homes.length, 1);
    assert.equal(b.view.homes.length, 1);
    assert.ok(a.view.miners.every((m) => m.team === 0));
    assert.ok(b.view.miners.every((m) => m.team === 1));
    assert.equal(a.view.me, 0);
    assert.equal(b.view.me, 1);
    // 下指令：派一名礦工往右挖
    const m = a.view.miners[0];
    a.send({ t: 'cmd', c: { type: 'move', minerId: m.id, x: m.x + 6, y: m.y } });
    await a.wait((x) => x.t === 'view' && x.v.miners.some((q) => q.id === m.id && q.task === 1));
    // 對手的礦工不聽我的
    const foeId = b.view.miners[0].id;
    a.send({ t: 'cmd', c: { type: 'move', minerId: foeId, x: 1, y: 1 } });
    // 亂送的東西不會弄壞伺服器
    a.ws.send('不是 JSON');
    a.send({ t: 'cmd', c: { type: 'buy', item: '__proto__' } });
    a.send({ t: 'nonsense' });
    const t0 = a.view.tick;
    await a.wait((x) => x.t === 'view' && x.v.tick >= t0 + 5);
    assert.equal(b.view.miners.find((q) => q.id === foeId).task, 0);
    assert.ok(Number.isFinite(a.view.money));
    // 表情兩邊都收得到
    b.send({ t: 'cmd', c: { type: 'emote', id: 'good' } });
    await a.wait((x) => x.t === 'view' && x.v.events.some((e) => e.type === 'emote' && e.team === 1 && e.id === 'good'));
    // 延遲資訊
    a.send({ t: 'ping', ts: 1, rtt: 12 });
    await a.wait((x) => x.t === 'pong' && x.ts === 1);
    // B 認輸
    b.send({ t: 'cmd', c: { type: 'surrender' } });
    const over = await a.wait((x) => x.t === 'view' && x.v.over);
    assert.equal(over.v.over.winner, 0);
    assert.equal(over.v.over.reason, 'surrender');
    assert.equal(over.v.over.stats.length, 2);
    await b.wait((x) => x.t === 'view' && x.v.over);
    // 結算後房間回到等待狀態，可以再來一局
    const back = await a.wait((x) => x.t === 'room' && x.state === 'lobby' && x.players.length === 2 && !x.players[0].ready && a.msgs.indexOf(x) > a.msgs.indexOf(over));
    assert.ok(back);
    a.msgs.length = 0;
    b.msgs.length = 0;
    a.send({ t: 'ready', on: true });
    b.send({ t: 'ready', on: true });
    await a.wait((x) => x.t === 'start');
    await b.wait((x) => x.t === 'view' && x.v.tick >= 2 && !x.v.over);
    a.ws.close();
    b.ws.close();
  } finally {
    s.close();
  }
});

test('連線對戰：登入的玩家打完會記戰績', async () => {
  const s = await startServer();
  try {
    const { a, b } = await seated(s);
    a.send({ t: 'register', name: '阿明', pass: 'secret-pass' });
    const auth = await a.wait((m) => m.t === 'auth');
    assert.equal(auth.ok, true);
    await b.wait((m) => m.t === 'room' && m.players[0].name === '阿明' && m.players[0].rec);
    a.send({ t: 'ready', on: true });
    b.send({ t: 'ready', on: true });
    await b.wait((m) => m.t === 'view' && m.v.tick >= 2);
    b.send({ t: 'cmd', c: { type: 'surrender' } });
    await a.wait((m) => m.t === 'me' && m.user && m.user.wins === 1);
    assert.deepEqual(s.accounts.info('阿明'), { name: '阿明', wins: 1, losses: 0, draws: 0 });
    a.send({ t: 'top' });
    const top = await a.wait((m) => m.t === 'top');
    assert.equal(top.list[0].name, '阿明');
    a.ws.close();
    b.ws.close();
  } finally {
    s.close();
  }
});

test('連線對戰：斷線後在時限內回來可以接著打；沒回來就算輸', async () => {
  const s = await startServer({ graceMs: 400 });
  try {
    const { a, b } = await playing(s);
    b.ws.close();
    const net = await a.wait((m) => m.t === 'net' && m.off[1] === true, 3000);
    assert.equal(net.off[0], false);
    // B 用同一個代號重新連線
    const b2 = await player(s.url, { cid: 'bbbbbbbb2222', name: '小華' }).ready;
    const st = await b2.wait((m) => m.t === 'start');
    assert.equal(st.me, 1);
    const first = await b2.wait((m) => m.t === 'view');
    assert.ok(first.v.g.know && first.v.g.know.f, '重連後第一包要是完整地圖');
    assert.ok(b2.view.tick > 3);
    assert.ok(b2.view.miners.every((m) => m.team === 1));
    await a.wait((m) => m.t === 'net' && m.off[1] === false && a.msgs.indexOf(m) > a.msgs.indexOf(net), 3000);
    assert.ok(!a.view.over, '有回來就不該判輸');
    // 這次 A 斷線而且不回來
    a.ws.close();
    const over = await b2.wait((m) => m.t === 'view' && m.v.over, 3000);
    assert.equal(over.v.over.winner, 1);
    assert.equal(over.v.over.reason, 'disconnect');
    const room = await b2.wait((m) => m.t === 'room' && m.players.length === 1 && m.state === 'lobby');
    assert.equal(room.players[0].name, '小華');
    b2.ws.close();
  } finally {
    s.close();
  }
});

test('大廳：快速配對把兩個人湊進同一間；房號不對會回報', async () => {
  const s = await startServer();
  try {
    const a = await player(s.url, { cid: 'cccccccc3333' }).ready;
    const b = await player(s.url, { cid: 'dddddddd4444' }).ready;
    await a.wait((m) => m.t === 'welcome');
    await b.wait((m) => m.t === 'welcome');
    b.send({ t: 'join', code: '0000' });
    assert.match((await b.wait((m) => m.t === 'error')).msg, /找不到/);
    a.send({ t: 'quick' });
    const ra = await a.wait((m) => m.t === 'room');
    assert.equal(ra.open, true);
    b.send({ t: 'quick' });
    const rb = await b.wait((m) => m.t === 'room');
    assert.equal(rb.code, ra.code);
    assert.equal(rb.you, 1);
    // 離開房間後另一個人還在
    b.send({ t: 'leave' });
    await b.wait((m) => m.t === 'left');
    await a.wait((m) => m.t === 'room' && m.players.length === 1 && a.msgs.indexOf(m) > a.msgs.indexOf(ra));
    assert.equal(s.lobby.rooms.size, 1);
    a.ws.close();
    b.ws.close();
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal(s.lobby.rooms.size, 0, '沒人的房間要清掉');
  } finally {
    s.close();
  }
});
