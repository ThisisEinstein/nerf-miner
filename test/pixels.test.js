// 像素圖資料的測試：每一張圖都要能建出來（列長一致、顏色都有定義），尺寸也要對。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as px from '../src/client/pixels.js';
import { ITEMS } from '../src/sim/items.js';
import { CHAR_IDS } from '../src/sim/chars.js';

const filled = (p) => p.d.filter(Boolean).length;

test('每個道具都有 16×16 的像素圖示', () => {
  assert.deepEqual([...px.ICON_IDS].sort(), Object.keys(ITEMS).sort());
  for (const id of px.ICON_IDS) {
    const p = px.iconPix(id);
    assert.equal(p.w, 16, id);
    assert.equal(p.h, 16, id);
    assert.ok(filled(p) > 30, `${id} 幾乎是空的`);
    assert.ok(p.d.every((c) => c === null || /^#[0-9a-f]{6}$/i.test(c)), `${id} 有不合法的顏色`);
  }
});

test('礦工：四個角色、兩隊、每個姿勢都建得出來', () => {
  for (const ch of CHAR_IDS) {
    for (const team of [0, 1]) {
      for (const [pose, frames] of [['idle', 1], ['walk', 2], ['dig', 2]]) {
        for (let f = 0; f < frames; f++) {
          const p = px.minerPix(team, ch, pose, f);
          assert.equal(p.w * p.h, 256);
          assert.ok(filled(p) > 90, `${ch} ${pose}${f}`);
          assert.ok(p.d.includes(px.TEAM[team].main), `${ch} 身上要有隊伍顏色`);
        }
      }
    }
  }
  // 走路的兩格不一樣、挖掘的兩格不一樣
  assert.notDeepEqual(px.minerPix(0, 'digger', 'walk', 0).d, px.minerPix(0, 'digger', 'walk', 1).d);
  assert.notDeepEqual(px.minerPix(0, 'digger', 'dig', 0).d, px.minerPix(0, 'digger', 'dig', 1).d);
  // 四個角色看起來不一樣
  const looks = new Set(CHAR_IDS.map((ch) => px.minerPix(0, ch).d.join()));
  assert.equal(looks.size, CHAR_IDS.length);
  // 翻面之後再翻回來是同一張
  const a = px.minerPix(1, 'guard');
  assert.deepEqual(a.flip().flip().d, a.d);
});

test('地圖物件與地形材質', () => {
  for (const team of [0, 1]) {
    const h = px.homePix(team);
    assert.equal(h.w, 48);
    assert.equal(h.h, 48);
    assert.ok(filled(h) > 2000);
    assert.ok(h.d.every((c) => c === null || /^#[0-9a-f]{6}$/i.test(c)), '家的顏色都要合法');
    for (let f = 0; f < 3; f++) assert.equal(px.torchPix(team, f).w, 16);
    assert.equal(px.laserPix(team).h, 16);
    assert.ok(filled(px.flagPix(team, 0)) > 10);
  }
  for (const make of [px.minePix, px.chestPix, px.spikePix, px.supportPix]) assert.equal(make().w, 16);
  for (let f = 0; f < 4; f++) assert.ok(filled(px.portalPix(f)) > 60);
  assert.notDeepEqual(px.portalPix(0).d, px.portalPix(1).d, '傳送門要會動');
  for (const make of [px.dirtPix, px.hardPix, px.rockPix, px.floorPix, px.unknownPix]) {
    const p = make(1);
    assert.equal(filled(p), 256, '地形要填滿整格');
    assert.notDeepEqual(make(1).d, make(2).d, '不同種子要長得不一樣');
    assert.deepEqual(make(7).d, make(7).d, '同一個種子要一樣');
  }
  for (const kind of [0, 1, 2]) assert.equal(px.facePix(kind, 3).h, 6);
  assert.ok(filled(px.orePix(1)) > 8);
  assert.ok(filled(px.mudPix(1)) > 20);
  for (const name of px.DECOR_NAMES) assert.ok(filled(px.decorPix(name)) > 3, name);
  assert.ok(filled(px.skullPix()) > 30);
  assert.ok(filled(px.bombSmallPix()) > 30);
  assert.ok(filled(px.zzzPix()) > 8);
});

test('列長不一致或用了沒定義的顏色會直接報錯', () => {
  assert.throws(() => new px.Pix().ascii(['....', '...'], null, 0, 0, '壞圖'), /壞圖/);
  assert.throws(() => new px.Pix().ascii(['.@..'], null, 0, 0, '壞圖'), /沒定義的顏色/);
  assert.equal(px.shade('#804020', 0.5), '#402010');
});
