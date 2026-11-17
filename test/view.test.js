// 玩家視角與連線編碼的測試：不該知道的東西不能出現在視角裡。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/sim/game.js';
import { Bot } from '../src/ai/bot.js';
import { makeView, ViewEncoder, ViewDecoder, GRIDS } from '../src/sim/view.js';
import { charMod, CHAR_IDS } from '../src/sim/chars.js';
import { priceOf } from '../src/sim/items.js';
import { C } from '../src/sim/constants.js';

test('開局的視角：只有自己的家和礦工，看不到對手', () => {
  const g = new Game(7);
  const v = makeView(g, 0);
  assert.equal(v.me, 0);
  assert.equal(v.homes.length, 1);
  assert.equal(v.homes[0].team, 0);
  assert.ok(v.miners.length === C.startMiners && v.miners.every((m) => m.team === 0));
  assert.equal(v.share, null, '4 分鐘前不該知道視野佔比');
  const json = JSON.stringify(new ViewEncoder().encode(v));
  assert.ok(!json.includes('"money":' + g.teams[1].money + ',"stock"') || g.teams[0].money === g.teams[1].money);
  assert.ok(!('teams' in v), '視角裡不該有完整的隊伍資料');
});

test('敵方的陷阱、未開火的激光塔、假的家的真假都看不出來', () => {
  const g = new Game(11);
  const hm = g.homes[0];
  // 敵方（隊伍 1）在我方家旁邊偷放的東西
  g.spikes.push({ team: 1, x: hm.cx + 2, y: hm.cy });
  g.lasers.push({ team: 1, x: hm.cx - 2, y: hm.cy, cd: 99, revealed: false });
  // 敵方的假的家，而且我方已經看到它
  g.homes.push({ team: 1, cx: hm.cx, cy: hm.cy + 4, fake: true, dead: false });
  g.teams[0].seenHomes.add(2);
  g.updateVision();
  const v = makeView(g, 0);
  assert.equal(v.spikes.length, 0, '敵方尖刺不該出現');
  assert.equal(v.lasers.length, 0, '還沒開火的敵方激光塔不該出現');
  const foe = v.homes.find((h) => h.team === 1);
  assert.ok(foe, '看到的敵方的家要出現');
  assert.equal(foe.fake, false, '敵方的家是真是假不能外流');
  assert.equal(foe.sure, false);
  // 對放的那一方來說則都看得到
  const w = makeView(g, 1);
  assert.equal(w.spikes.length, 1);
  assert.equal(w.lasers.length, 1);
  assert.equal(w.homes.find((h) => h.id === 2).fake, true);
});

test('敵方礦工只有在看得到的格子上才出現，而且看不到他拿什麼（炸彈除外）', () => {
  const g = new Game(5);
  const hm = g.homes[0];
  const e = g.miners.find((m) => m.team === 1);
  e.carry = 'laser';
  assert.ok(!makeView(g, 0).miners.some((m) => m.team === 1), '遠處的敵方礦工不該出現');
  e.x = hm.cx + 3;
  e.y = hm.cy;
  g.updateVision();
  let seen = makeView(g, 0).miners.find((m) => m.id === e.id);
  assert.ok(seen, '走進視野就看得到');
  assert.equal(seen.carry, null);
  assert.ok(!('path' in seen) && !('buffs' in seen) && !('eta' in seen));
  e.carry = 'bomb';
  seen = makeView(g, 0).miners.find((m) => m.id === e.id);
  assert.equal(seen.carry, 'bomb');
});

test('連線編碼：差異傳輸還原後和原本的視角完全一樣', () => {
  const g = new Game(2024, { chars: ['scout', 'guard'] });
  const bots = [new Bot(g, 0, 'hard'), new Bot(g, 1, 'hard')];
  const enc = [new ViewEncoder(), new ViewEncoder()];
  const dec = [new ViewDecoder(), new ViewDecoder()];
  let bytes = 0;
  let frames = 0;
  for (let t = 0; t < 900 && !g.over; t++) {
    for (const b of bots) b.update();
    g.step();
    for (const k of [0, 1]) {
      const v = makeView(g, k);
      const wire = JSON.stringify(enc[k].encode(v));
      bytes += wire.length;
      frames++;
      const back = dec[k].decode(JSON.parse(wire));
      for (const name of GRIDS) assert.deepEqual(back[name], Uint8Array.from(v[name]), `${name} 在 tick ${g.tick} 不一致`);
      assert.equal(back.money, v.money);
      assert.deepEqual(back.miners, JSON.parse(JSON.stringify(v.miners)));
    }
    g.events.length = 0;
  }
  // 重新連線：編碼器重設後第一包要是完整資料
  enc[0].reset();
  const full = enc[0].encode(makeView(g, 0));
  assert.ok(GRIDS.every((name) => full.g[name] && full.g[name].f), '重設後要送整張');
  const fresh = new ViewDecoder().decode(JSON.parse(JSON.stringify(full)));
  assert.deepEqual(fresh.know, Uint8Array.from(g.teams[0].know));
  assert.ok(bytes / frames < 6000, `每個 tick 平均 ${Math.round(bytes / frames)} bytes，太大了`);
});

test('角色加成', () => {
  assert.deepEqual(charMod(null), { dig: 1, vision: 0, price: 1, hp: 0 });
  assert.deepEqual(charMod('__proto__'), { dig: 1, vision: 0, price: 1, hp: 0 });
  assert.equal(CHAR_IDS.length, 4);
  const g = new Game(3, { chars: ['guard', 'merchant'] });
  const a = g.miners.find((m) => m.team === 0);
  assert.equal(a.hp, C.hp[0] + 1);
  assert.equal(g.maxHp(a), C.hp[0] + 1);
  assert.equal(g.price(1, 'bomb'), priceOf('bomb', 0.85));
  assert.equal(g.price(1, 'bomb'), 130);
  assert.equal(g.price(0, 'bomb'), 150);
  g.teams[1].money = 130;
  g.teams[1].stock = [];
  g.command(1, { type: 'buy', item: 'bomb' });
  g.step();
  assert.ok(g.teams[1].stock.includes('bomb'), '商人用折扣價買得到炸彈');
  // 亂七八糟的道具代號不能弄壞金額
  g.command(0, { type: 'buy', item: '__proto__' });
  g.command(0, { type: 'buy', item: 'constructor' });
  g.step();
  assert.ok(Number.isFinite(g.teams[0].money));
  const s = new Game(3, { chars: ['scout', null] });
  let n0 = 0;
  let n1 = 0;
  for (let i = 0; i < s.teams[0].visible.length; i++) {
    n0 += s.teams[0].visible[i];
    n1 += s.teams[1].visible[i];
  }
  assert.ok(n0 >= n1, '探險家的視野不會比較小');
});
