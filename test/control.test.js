// 操作便利功能的測試：任務排隊、走到定點自動使用道具、指定方向使用、自動探索。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/sim/game.js';
import { makeView } from '../src/sim/view.js';
import { cleanCmd } from '../src/server/lobby.js';
import { C, T, idx } from '../src/sim/constants.js';

const run = (g, n) => {
  for (let k = 0; k < n && !g.over; k++) g.step();
};
const first = (g, team) => g.miners.find((m) => m.team === team);

test('任務排隊：做完一個接著做下一個；停下會清掉排隊', () => {
  const g = new Game(101);
  const m = first(g, 0);
  const a = { x: m.x + 3, y: m.y };
  const b = { x: m.x + 3, y: m.y - 3 };
  g.command(0, { type: 'move', minerId: m.id, x: a.x, y: a.y });
  g.command(0, { type: 'move', minerId: m.id, x: b.x, y: b.y, queue: true });
  g.step();
  assert.equal(m.queue.length, 1);
  assert.deepEqual(makeView(g, 0).miners.find((q) => q.id === m.id).queue, [idx(b.x, b.y)]);
  let visitedA = false;
  for (let k = 0; k < 400 && !(m.x === b.x && m.y === b.y); k++) {
    g.step();
    if (m.x === a.x && m.y === a.y) visitedA = true;
  }
  assert.ok(visitedA, '先到第一個點');
  assert.deepEqual([m.x, m.y], [b.x, b.y], '再到排隊的第二個點');
  assert.equal(m.queue.length, 0);
  // 沒加 queue 的新指令會取代全部
  g.command(0, { type: 'move', minerId: m.id, x: a.x, y: a.y });
  g.command(0, { type: 'move', minerId: m.id, x: b.x, y: b.y, queue: true });
  g.command(0, { type: 'move', minerId: m.id, x: m.x, y: m.y + 2 });
  g.step();
  assert.equal(m.queue.length, 0);
  g.command(0, { type: 'move', minerId: m.id, x: a.x, y: a.y, queue: true });
  g.command(0, { type: 'stop', minerId: m.id });
  g.step();
  assert.equal(m.task, null);
  assert.equal(m.queue.length, 0);
  // 排隊有上限
  g.command(0, { type: 'move', minerId: m.id, x: a.x, y: a.y });
  for (let k = 0; k < 20; k++) g.command(0, { type: 'move', minerId: m.id, x: b.x, y: b.y, queue: true });
  g.step();
  assert.equal(m.queue.length, C.maxQueue);
});

test('走到定點自動使用：激光塔會放在指定的格子上', () => {
  const g = new Game(102);
  const m = first(g, 0);
  m.carry = 'laser';
  const x = m.x + 4;
  const y = m.y;
  g.command(0, { type: 'move', minerId: m.id, x, y, use: true });
  run(g, 300);
  assert.equal(g.lasers.length, 1);
  assert.deepEqual([g.lasers[0].x, g.lasers[0].y, g.lasers[0].team], [x, y, 0]);
  assert.equal(m.carry, null);
});

test('先回家拿、再排隊去放：一次下完兩個指令', () => {
  const g = new Game(103);
  const m = first(g, 0);
  const hm = g.homes[0];
  g.teams[0].stock.push('spike');
  // 先把礦工派到外面
  g.command(0, { type: 'move', minerId: m.id, x: hm.cx + 5, y: hm.cy });
  run(g, 150);
  g.command(0, { type: 'pickup', minerId: m.id, item: 'spike' });
  g.command(0, { type: 'move', minerId: m.id, x: hm.cx + 4, y: hm.cy, queue: true, use: true });
  g.step();
  assert.equal(makeView(g, 0).miners.find((q) => q.id === m.id).fetch, 'spike');
  run(g, 300);
  assert.equal(g.spikes.length, 1);
  assert.deepEqual([g.spikes[0].x, g.spikes[0].y], [hm.cx + 4, hm.cy]);
});

test('指定方向使用 TNT', () => {
  const g = new Game(104);
  const m = first(g, 0);
  m.x = 25;
  m.y = 25;
  // 四周都鋪成土，方便檢查
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (dx || dy) g.tiles[idx(25 + dx, 25 + dy)] = T.DIRT;
  g.tiles[idx(25, 25)] = T.FLOOR;
  m.carry = 'tnt';
  g.command(0, { type: 'use', minerId: m.id, dx: 0, dy: -1 });
  run(g, C.useTicks + 3);
  for (let d = 1; d <= 4; d++) for (let l = -1; l <= 1; l++) assert.equal(g.tiles[idx(25 + l, 25 - d)], T.FLOOR, `上方 (${l}, -${d}) 要被炸開`);
  assert.equal(g.tiles[idx(27, 25)], T.DIRT, '右邊不受影響');
  // 亂給的方向會被忽略，照原本面向使用
  m.carry = 'tnt';
  m.dir = [1, 0];
  g.command(0, { type: 'use', minerId: m.id, dx: 3, dy: 9 });
  run(g, C.useTicks + 3);
  assert.equal(g.tiles[idx(27, 25)], T.FLOOR);
});

test('自動探索：開了之後不用下指令，視野也會一直擴大', () => {
  const g = new Game(105);
  const before = g.teams[0].litCount;
  for (const m of g.miners.filter((q) => q.team === 0)) g.command(0, { type: 'auto', minerId: m.id, on: true });
  run(g, 900);
  assert.ok(g.teams[0].litCount > before + 80, `視野從 ${before} 變成 ${g.teams[0].litCount}`);
  assert.ok(g.teams[0].stats.dug > 30);
  assert.ok(makeView(g, 0).miners.every((q) => q.auto === 1));
  // 沒開的那一隊不會自己動
  assert.equal(g.teams[1].stats.dug, 0);
  // 手動指令優先；做完之後繼續自動
  const m = first(g, 0);
  const hm = g.homes[0];
  g.command(0, { type: 'move', minerId: m.id, x: hm.cx, y: hm.cy });
  run(g, 400);
  assert.ok(m.task || m.act || m.x !== hm.cx || m.y !== hm.cy || m.state === 'fountain', '回到家之後又自己出門了');
  // 關掉就停
  g.command(0, { type: 'auto', minerId: m.id, on: false });
  g.command(0, { type: 'stop', minerId: m.id });
  run(g, 60);
  const pos = [m.x, m.y];
  run(g, 100);
  assert.deepEqual([m.x, m.y], pos);
});

test('自動探索：站在礦井或大寶藏上佔領時不會自己跑掉', () => {
  const g = new Game(106);
  const m = first(g, 0);
  const mn = g.mines.find((q) => q.neutral);
  m.x = mn.x;
  m.y = mn.y;
  g.command(0, { type: 'auto', minerId: m.id, on: true });
  run(g, C.captureTicks + 5);
  assert.equal(mn.owner, 0, '礦井佔領成功');
  // 佔領完成後就繼續自動探索
  run(g, 200);
  assert.ok(m.x !== mn.x || m.y !== mn.y, '佔領完之後自己出門');

  const g2 = new Game(107);
  const m2 = first(g2, 0);
  const tr = g2.treasure;
  m2.x = tr.x;
  m2.y = tr.y;
  g2.command(0, { type: 'auto', minerId: m2.id, on: true });
  run(g2, C.treasureTicks + 5);
  assert.ok(tr.taken, '大寶藏搶到了');
  assert.ok(g2.teams[0].money >= C.treasureMoney);
});

test('連線指令過濾：新欄位', () => {
  assert.deepEqual(cleanCmd({ type: 'move', minerId: 1, x: 2, y: 3, queue: true, use: 'yes' }), { type: 'move', minerId: 1, x: 2, y: 3, queue: true, use: false });
  assert.deepEqual(cleanCmd({ type: 'use', minerId: 1, dx: 0, dy: 1 }), { type: 'use', minerId: 1, dx: 0, dy: 1 });
  assert.deepEqual(cleanCmd({ type: 'use', minerId: 1, dx: 5, dy: 1 }), { type: 'use', minerId: 1 });
  assert.deepEqual(cleanCmd({ type: 'auto', minerId: 1, on: 1 }), { type: 'auto', minerId: 1, on: false });
  assert.deepEqual(cleanCmd({ type: 'auto', minerId: 1, on: true }), { type: 'auto', minerId: 1, on: true });
  assert.equal(cleanCmd({ type: 'auto', minerId: 'x', on: true }), null);
});
