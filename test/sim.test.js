import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/sim/game.js';
import { generateMap } from '../src/sim/mapgen.js';
import { Bot } from '../src/ai/bot.js';
import { W, H, N, T, C, MATCH_TICKS, idx } from '../src/sim/constants.js';
import { ITEMS } from '../src/sim/items.js';
import { makeView } from '../src/sim/view.js';

const man = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);
const run = (g, ticks, each) => {
  for (let k = 0; k < ticks && !g.over; k++) {
    if (each) each();
    g.step();
    g.events.length = 0;
  }
};
const firstOf = (g, team) => g.miners.find((m) => m.team === team);

test('地圖生成：200 個種子都合法且公平', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const m = generateMap(seed);
    const [h0, h1] = m.homes;
    assert.ok(h0.cx < 25 && h1.cx > 25, '兩個家各在一側');
    for (const h of m.homes) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.equal(m.tiles[idx(h.cx + dx, h.cy + dy)], T.FLOOR);
    }
    assert.equal(m.mines.length, 5);
    for (const mn of m.mines) {
      assert.equal(m.tiles[idx(mn.x, mn.y)], T.FLOOR);
      if (mn.neutral) {
        const d = Math.abs(man(mn.x, mn.y, h0.cx, h0.cy) - man(mn.x, mn.y, h1.cx, h1.cy));
        assert.ok(d <= 2, `中立礦井到兩個家的距離差 ${d}`);
      }
    }
    const own = m.mines.filter((x) => !x.neutral);
    assert.equal(man(own[0].x, own[0].y, h0.cx, h0.cy), man(own[1].x, own[1].y, h1.cx, h1.cy), '一般礦井離家一樣遠');
    const t = m.treasure;
    assert.ok(Math.abs(man(t.x, t.y, h0.cx, h0.cy) - man(t.x, t.y, h1.cx, h1.cy)) <= 1, '大寶藏在正中間');
    let rock = 0;
    for (let i = 0; i < N; i++) if (m.tiles[i] === T.ROCK) rock++;
    assert.ok(rock > 20 && rock < 500, `石頭數量合理：${rock}`);
  }
});

test('開局狀態：3 名礦工、家的視野 61 格、一顆炸彈在家', () => {
  const g = new Game(7);
  for (const tm of g.teams) {
    assert.equal(g.minersOf(tm.id).length, 3);
    assert.equal(tm.litCount, 61);
    assert.deepEqual(tm.stock, ['bomb']);
    assert.equal(tm.money, C.startMoney);
  }
  assert.equal(g.teams[0].seenHomes.size, 0, '一開始不知道敵方的家');
});

test('礦工會挖路、插火把、賺錢，視野跟著變大', () => {
  const g = new Game(11);
  const m = firstOf(g, 0);
  const before = g.teams[0].litCount;
  g.command(0, { type: 'move', minerId: m.id, x: m.x + 12, y: m.y });
  run(g, 400);
  assert.ok(g.teams[0].litCount > before + 15, '火把增加了視野');
  assert.ok(g.teams[0].stats.dug > 0);
  let torches = 0;
  for (let i = 0; i < N; i++) if (g.torch[i] === 0) torches++;
  assert.ok(torches >= 2, `插了 ${torches} 根火把`);
});

test('炸彈送進敵方的家就獲勝', () => {
  const g = new Game(21);
  const m = firstOf(g, 0);
  g.revealHome(0);
  g.command(0, { type: 'pickup', minerId: m.id, item: 'bomb' });
  run(g, 5);
  assert.equal(m.carry, 'bomb');
  const e = g.homes[1];
  g.command(0, { type: 'move', minerId: m.id, x: e.cx, y: e.cy });
  run(g, MATCH_TICKS - 10);
  assert.ok(g.over, '比賽結束');
  assert.equal(g.over.winner, 0);
  assert.equal(g.over.reason, 'bomb');
});

test('沒帶炸彈的礦工進不了敵方的家', () => {
  const g = new Game(22);
  const m = firstOf(g, 0);
  g.revealHome(0);
  const e = g.homes[1];
  g.command(0, { type: 'move', minerId: m.id, x: e.cx, y: e.cy });
  run(g, 1500);
  assert.equal(g.over, null);
  assert.ok(g.homeAt[idx(m.x, m.y)] !== 1, '停在家外面');
});

test('時間到比視野範圍', () => {
  const g = new Game(31);
  const m = firstOf(g, 0);
  g.command(0, { type: 'move', minerId: m.id, x: m.x + 8, y: m.y });
  run(g, MATCH_TICKS + 5);
  assert.ok(g.over);
  assert.equal(g.over.reason, 'vision');
  assert.equal(g.over.winner, 0, '有挖路插火把的一方視野較大');
  assert.equal(g.tick, MATCH_TICKS);
});

test('激光塔把敵方礦工打回泉水，之後會復活', () => {
  const g = new Game(41);
  const a = firstOf(g, 0);
  const b = firstOf(g, 1);
  a.x = 20;
  a.y = 20;
  b.x = 22;
  b.y = 20;
  g.tiles[idx(20, 20)] = T.FLOOR;
  a.carry = 'laser';
  g.command(0, { type: 'use', minerId: a.id });
  run(g, 30);
  assert.equal(g.lasers.length, 1);
  assert.equal(b.state, 'fountain');
  run(g, C.respawnTicks + 2);
  assert.equal(b.state, 'idle');
  assert.equal(b.x, g.homes[1].cx);
});

test('尖刺只能用一次', () => {
  const g = new Game(42);
  const b = firstOf(g, 1);
  g.tiles[idx(20, 20)] = T.FLOOR;
  g.tiles[idx(21, 20)] = T.FLOOR;
  g.spikes.push({ team: 0, x: 21, y: 20 });
  b.x = 20;
  b.y = 20;
  g.command(1, { type: 'move', minerId: b.id, x: 21, y: 20 });
  run(g, 20);
  assert.equal(b.state, 'fountain');
  assert.equal(g.spikes.length, 0);
});

test('假的家會騙掉炸彈', () => {
  const g = new Game(43);
  const a = firstOf(g, 0);
  const b = firstOf(g, 1);
  a.x = 25;
  a.y = 25;
  a.carry = 'fake';
  g.command(0, { type: 'use', minerId: a.id });
  run(g, 12);
  assert.equal(g.homes.length, 3);
  assert.equal(a.carry, null);
  a.x = g.homes[0].cx;
  a.y = g.homes[0].cy;
  b.x = 25;
  b.y = 28;
  g.tiles[idx(25, 28)] = T.FLOOR;
  b.carry = 'bomb';
  g.teams[1].stock = [];
  g.teams[1].seenHomes.add(2);
  g.command(1, { type: 'move', minerId: b.id, x: 25, y: 25 });
  run(g, 80);
  assert.equal(g.over, null, '炸到假的家不會結束比賽');
  assert.equal(b.carry, null, '炸彈沒了');
  assert.equal(g.homes[2].dead, true);
  assert.equal(g.hasBomb(1), false);
});

test('站在中立礦井上 3 秒可以佔領並開始生錢', () => {
  const g = new Game(51);
  const mn = g.mines.find((x) => x.neutral);
  const a = firstOf(g, 0);
  a.x = mn.x;
  a.y = mn.y;
  run(g, C.captureTicks + 2);
  assert.equal(mn.owner, 0);
  const money = g.teams[0].money;
  run(g, 100);
  assert.ok(g.teams[0].money >= money + 10 * (C.homeIncome + C.mineIncome + C.neutralIncome));
});

test('大寶藏：站滿 8 秒拿到 $80，並在自己這一側多一個假的家', () => {
  for (const seed of [52, 53, 54, 55, 56, 57]) {
    for (const team of [0, 1]) {
      const g = new Game(seed);
      const a = firstOf(g, team);
      a.x = g.treasure.x;
      a.y = g.treasure.y;
      const money = g.teams[team].money;
      run(g, C.treasureTicks + 2);
      assert.equal(g.treasure.taken, true);
      assert.equal(C.treasureMoney, 80);
      assert.ok(g.teams[team].money >= money + C.treasureMoney);
      assert.equal(g.teams[team].confirmedHome, -1, '大寶藏不再透露敵方的家');
      assert.equal(g.homes.length, 3, '多了一個家');
      const f = g.homes[2];
      const real = g.homes[team];
      assert.ok(f.fake && !f.dead && f.team === team, '那是自己的假的家');
      assert.ok(team === 0 ? f.cx >= 5 && f.cx <= 11 : f.cx >= 38 && f.cx <= 44, `假的家要在自己這一側（x=${f.cx}）`);
      assert.ok(Math.abs(f.cx - real.cx) + Math.abs(f.cy - real.cy) >= 8, '不會貼著真的家');
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = (f.cy + dy) * 50 + f.cx + dx;
          assert.equal(g.homeAt[i], 2);
          assert.equal(g.tiles[i], 3, '假的家的 3×3 都是通道');
          assert.equal(g.teams[team].know[i], 3, '自己知道假的家在哪');
        }
      }
      // 對手只知道寶藏被搶了，看不到那個假的家
      assert.equal(makeView(g, 1 - team).homes.length, 1);
      assert.equal(makeView(g, team).homes.filter((h) => h.fake).length, 1);
    }
  }
});

test('中立礦井的位置開局就公開；對手自帶的那一座要看到才知道', () => {
  const g = new Game(77);
  const neutral = g.mines.filter((m) => m.neutral).length;
  assert.equal(neutral, 3);
  for (const team of [0, 1]) {
    const foeMine = g.mines.find((m) => !m.neutral && m.owner === 1 - team);
    assert.equal(g.teams[team].knownMines.size, neutral + 1);
    assert.ok(!g.teams[team].knownMines.has(foeMine.id), '對手自帶的礦井不公開');
    const v = makeView(g, team);
    assert.equal(v.mines.length, neutral + 1);
    assert.ok(!v.mines.some((m) => m.x === foeMine.x && m.y === foeMine.y));
    // 只知道自己那一座是誰的，中立的看起來都還沒人佔
    assert.equal(v.mines.filter((m) => m.owner === team).length, 1);
    assert.equal(v.mines.filter((m) => m.owner === 1 - team).length, 0);
    assert.equal(v.mines.filter((m) => m.neutral).length, neutral);
  }
  // 走到看得見的地方就會知道
  const foeMine = g.mines.find((m) => !m.neutral && m.owner === 1);
  const a = firstOf(g, 0);
  a.x = foeMine.x + 1;
  a.y = foeMine.y;
  g.updateVision();
  const seen = makeView(g, 0).mines.find((m) => m.id === foeMine.id);
  assert.ok(seen && seen.owner === 1, '親眼看到之後才出現，也知道是對手的');
  run(g, 3 * 60 * 10 + 5);
  assert.ok(!g.events.some((e) => e.type === 'announce'), '3 分鐘不再有礦井公告');
});

test('價格與概略情報', () => {
  assert.equal(ITEMS.intel2.price, 200);
  assert.equal(ITEMS.miner.price, 100);
  assert.equal(ITEMS.portal.price, 120);
  assert.equal(ITEMS.fake.price, 140);
  const g = new Game(91);
  g.teams[0].money = 50;
  g.command(0, { type: 'buy', item: 'intel1' });
  g.step();
  assert.equal(g.teams[0].money, 0, '概略情報 $50');
  const z = makeView(g, 0).intelZone;
  assert.ok(z, '買了概略情報，視角裡要有標示範圍');
  const e = g.homes[1];
  assert.ok(e.cx >= z.x && e.cx < z.x + z.w && e.cy >= z.y && e.cy < z.y + z.h, '敵方的家在範圍裡');
  // 就算之後看到一個敵方的家（可能是假的），範圍也還在；確認真家之後才收起來
  g.teams[0].seenHomes.add(1);
  assert.ok(makeView(g, 0).intelZone);
  g.revealHome(0);
  assert.equal(makeView(g, 0).intelZone, null);
});

test('商店：買礦工、升級、賣礦工、炸彈只能一顆', () => {
  const g = new Game(61);
  g.teams[0].money = 1000;
  g.command(0, { type: 'buy', item: 'bomb' });
  g.command(0, { type: 'buy', item: 'miner' });
  g.command(0, { type: 'buy', item: 'laser' });
  g.step();
  assert.equal(g.teams[0].stock.filter((x) => x === 'bomb').length, 1);
  assert.equal(g.minersOf(0).length, 4);
  assert.ok(g.teams[0].stock.includes('laser'));
  const m = firstOf(g, 0);
  g.command(0, { type: 'upgrade', minerId: m.id });
  g.step();
  assert.equal(m.level, 2);
  const money = g.teams[0].money;
  g.command(0, { type: 'sell', minerId: m.id });
  g.step();
  assert.equal(g.minersOf(0).length, 3);
  assert.equal(g.teams[0].money, money + C.sellBase + C.upgradeCost[0] / 2);
});

test('TNT 炸開 3×4 並插火把；拆火把會減少敵方視野', () => {
  const g = new Game(62);
  const a = firstOf(g, 0);
  a.x = 20;
  a.y = 30;
  a.dir = [1, 0];
  a.carry = 'tnt';
  for (let y = 28; y <= 32; y++) for (let x = 18; x <= 26; x++) g.tiles[idx(x, y)] = T.DIRT;
  g.tiles[idx(20, 30)] = T.FLOOR;
  g.command(0, { type: 'use', minerId: a.id });
  run(g, 12);
  for (let d = 1; d <= 4; d++) for (let l = -1; l <= 1; l++) assert.equal(g.tiles[idx(20 + d, 30 + l)], T.FLOOR);
  assert.equal(g.torch[idx(22, 30)], 0);
  const b = firstOf(g, 1);
  const lit = g.teams[0].litCount;
  b.x = 23;
  b.y = 30;
  b.carry = 'snuff';
  g.command(1, { type: 'use', minerId: b.id });
  run(g, 12);
  assert.ok(g.teams[0].litCount < lit);
});

test('電腦對電腦：40 局都能正常打完', () => {
  const tally = { 0: 0, 1: 0, draw: 0, bomb: 0, vision: 0 };
  let lit = 0;
  for (let seed = 100; seed < 140; seed++) {
    const g = new Game(seed);
    const bots = [new Bot(g, 0, 'normal'), new Bot(g, 1, ['easy', 'normal', 'hard'][seed % 3])];
    run(g, MATCH_TICKS + 5, () => bots.forEach((b) => b.update()));
    assert.ok(g.over, `seed ${seed} 有結束`);
    assert.ok(g.tick <= MATCH_TICKS);
    for (const m of g.miners) assert.ok(m.x >= 0 && m.y >= 0 && m.x < W && m.y < H);
    for (const tm of g.teams) assert.ok(tm.money >= 0, '錢不會變負的');
    tally[g.over.winner < 0 ? 'draw' : g.over.winner]++;
    tally[g.over.reason]++;
    lit += g.over.lit[0] + g.over.lit[1];
  }
  console.log('  勝負統計', tally, '平均每隊視野格數', Math.round(lit / 80));
  assert.ok(tally.bomb + tally.vision === 40);
});

test('沒帶炸彈卻被派去敵方的家：會走到家外面一圈停下，不會報到不了', () => {
  const g = new Game(23);
  const m = firstOf(g, 0);
  g.revealHome(0);
  const e = g.homes[1];
  g.command(0, { type: 'move', minerId: m.id, x: e.cx, y: e.cy });
  let failed = false;
  for (let k = 0; k < 1500 && !g.over; k++) {
    g.step();
    if (g.events.some((ev) => ev.type === 'msg' && ev.to === 0 && ev.text.includes('到不了'))) failed = true;
    g.events.length = 0;
  }
  assert.equal(failed, false);
  assert.equal(Math.max(Math.abs(m.x - e.cx), Math.abs(m.y - e.cy)), 2, '停在家外面一圈');
});
