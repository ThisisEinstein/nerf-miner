// 對局中的介面：上方資訊列、右側商店與庫存、下方礦工狀態欄、訊息與結算。只讀「玩家視角」。
import { C, TPS, MATCH_TICKS } from '../sim/constants.js';
import { ITEMS, CATEGORIES, priceOf } from '../sim/items.js';

const $ = (id) => document.getElementById(id);
const EMOTE = { smile: '😀', angry: '😡', cry: '😭', good: '👍', no: '才不要！', ask: '要不要投降？' };
const isItem = (id) => typeof id === 'string' && Object.hasOwn(ITEMS, id);
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// 礦工是不是站在還沒拿下的礦井或大寶藏上（正在佔領）
export function isCapturing(v, m) {
  if (!v) return false;
  if (v.treasure && !v.treasure.taken && v.treasure.x === m.x && v.treasure.y === m.y) return true;
  return (v.mines || []).some((q) => q.x === m.x && q.y === m.y && q.owner !== v.me);
}

// 礦工現在是不是閒著（沒任務、沒在做事、沒開自動探索、也不是在佔領）
export function isIdle(m, v) {
  return m.state !== 'fountain' && !m.act && !m.task && !m.auto && !m.frozen && !isCapturing(v, m);
}

export function statusText(v, m) {
  if (m.state === 'fountain') return `泉水蹲 · ${Math.ceil(m.respawn / TPS)} 秒後復活`;
  if (m.frozen > 0) return '被冰凍了';
  const eta = m.task && m.eta ? ` · 預計 ${Math.ceil(m.eta / TPS)} 秒` : '';
  const more = m.queue && m.queue.length ? ` · 後面排了 ${m.queue.length} 個` : '';
  if (m.fetch && isItem(m.fetch)) return `回家拿${ITEMS[m.fetch].name}${eta}${more}`;
  const auto = m.auto ? '自動探索 · ' : '';
  const a = m.act;
  if (a) {
    if (a.kind === 'dig') return `${auto}移動（挖掘中）${eta}${more}`;
    if (a.kind === 'walk') return `${auto}移動中${eta}${more}`;
    if (a.kind === 'teleport') return `傳送中${eta}${more}`;
    if (a.kind === 'torch') return `${auto}使用（插火把）${eta}${more}`;
    if (a.kind === 'use') return '使用道具中';
  }
  if (m.task) return `${auto}移動中${eta}${more}`;
  const mn = v.mines.find((q) => q.x === m.x && q.y === m.y);
  if (mn && mn.owner !== v.me) return '使用（佔領礦井中）';
  if (!v.treasure.taken && v.treasure.x === m.x && v.treasure.y === m.y) return '使用（搶大寶藏中）';
  return m.auto ? '自動探索（找不到地方挖）' : '待命 💤';
}

export class UI {
  // sprites：用來產生道具圖示
  constructor(handlers, sprites) {
    this.h = handlers;
    this.sp = sprites;
    this.cache = {};
    this.timers = {};
    this.mul = 1;
    this.avatar = '';
    this.buildShop();
    this.bind();
  }

  icon(id, cls = 'px') {
    return `<img class="${cls}" src="${this.sp.iconUrl(id)}" alt="">`;
  }

  buildShop() {
    let html = '';
    for (const cat of CATEGORIES) {
      html += `<h3>${cat}</h3><div class="grid">`;
      for (const [id, it] of Object.entries(ITEMS)) {
        if (it.cat !== cat) continue;
        html += `<button class="item" data-item="${id}">${this.icon(id)}<span class="nm">${it.name}</span><span class="pr">$${priceOf(id, this.mul)}</span></button>`;
      }
      html += '</div>';
    }
    $('items').innerHTML = html;
  }

  bind() {
    const h = this.h;
    const showDesc = (id) => {
      if (!isItem(id)) return;
      const it = ITEMS[id];
      const tip = it.instant ? '' : id === 'bomb' ? '' : '<br><span class="dim">右鍵：買了順便叫選取的礦工回家拿</span>';
      $('desc').innerHTML = `${this.icon(id, 'px s')}<b>${it.name}</b>（$${priceOf(id, this.mul)}）<br>${it.desc}${tip}`;
    };
    $('items').addEventListener('click', (e) => {
      const b = e.target.closest('[data-item]');
      if (b) h.buy(b.dataset.item, false);
    });
    $('items').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const b = e.target.closest('[data-item]');
      if (b) h.buy(b.dataset.item, true);
    });
    for (const id of ['items', 'stock']) {
      $(id).addEventListener('pointerover', (e) => {
        const b = e.target.closest('[data-item]');
        if (b) showDesc(b.dataset.item);
      });
    }
    // 這兩塊會頻繁重畫，用 pointerdown 才不會漏掉點擊
    $('stock').addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-item]');
      if (b) h.stock(b.dataset.item);
    });
    $('miners').addEventListener('pointerdown', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = Number(card.dataset.id);
      const act = e.target.closest('[data-act]');
      if (act && !act.disabled) h.minerAct(act.dataset.act, id);
      else h.select(id, e.shiftKey);
    });
    $('emotes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-emote]');
      if (b) h.emote(b.dataset.emote);
    });
    $('btn-taunt').addEventListener('click', () => h.taunt());
    $('btn-map').addEventListener('click', () => h.map());
    $('btn-help').addEventListener('click', () => $('help').classList.toggle('hidden'));
    $('help-close').addEventListener('click', () => $('help').classList.add('hidden'));
    $('btn-giveup').addEventListener('click', () => {
      const b = $('btn-giveup');
      if (b.dataset.sure) {
        delete b.dataset.sure;
        b.textContent = '投降';
        h.surrender();
        return;
      }
      b.dataset.sure = '1';
      b.textContent = '確定投降？';
      clearTimeout(this.timers.giveup);
      this.timers.giveup = setTimeout(() => {
        delete b.dataset.sure;
        b.textContent = '投降';
      }, 3000);
    });
    $('taunt-no').addEventListener('click', () => {
      $('taunt').classList.add('hidden');
      h.tauntAnswer(false);
    });
    $('taunt-yes').addEventListener('click', () => {
      $('taunt').classList.add('hidden');
      h.tauntAnswer(true);
    });
    $('again').addEventListener('click', () => h.again());
    $('to-menu').addEventListener('click', () => h.exit());
  }

  set(id, html) {
    if (this.cache[id] === html) return;
    this.cache[id] = html;
    $(id).innerHTML = html;
  }

  insets() {
    return { l: 0, t: $('topbar').offsetHeight, r: $('shop').offsetWidth, b: $('miners').offsetHeight };
  }

  // 開始一局。o: { me, names, priceMul, avatar, online }
  start(o) {
    this.cache = {};
    this.avatar = o.avatar;
    if (this.mul !== o.priceMul) {
      this.mul = o.priceMul;
      this.buildShop();
    }
    for (const id of ['over', 'taunt', 'help', 'netwarn', 'hint']) $(id).classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('netstat').classList.toggle('hidden', !o.online);
    $('log').innerHTML = '';
    $('banner').innerHTML = '';
    $('versus').innerHTML = `<span class="me">${esc(o.names[o.me])}</span> vs <span class="foe">${esc(o.names[1 - o.me])}</span>`;
    const b = $('btn-giveup');
    delete b.dataset.sure;
    b.textContent = '投降';
  }

  hide() {
    $('hud').classList.add('hidden');
    $('over').classList.add('hidden');
  }

  // sel：選取中的礦工編號（第一個是主要的那個）
  update(v, sel, mapMode) {
    this.set('money', String(v.money));
    const left = Math.max(0, MATCH_TICKS - v.tick);
    const s = Math.ceil(left / TPS);
    this.set('timer', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    $('timer').classList.toggle('late', s <= 60);
    if (v.share !== null) {
      const p = Math.round(v.share * 100);
      this.set('vision', `視野 <span class="me">你 ${p}%</span> : <span class="foe">對手 ${100 - p}%</span>`);
    } else {
      this.set('vision', `視野 <span class="me">${v.litCount}</span> 格`);
    }
    const mine = v.miners.filter((m) => m.team === v.me);
    const carrier = mine.find((m) => m.carry === 'bomb');
    this.set(
      'bomb',
      carrier
        ? `💣 ${mine.indexOf(carrier) + 1} 號攜帶中`
        : v.stock.includes('bomb')
          ? '💣 在家裡'
          : `💣 沒有（$${priceOf('bomb', this.mul)}）`,
    );
    this.set('btn-map', mapMode ? '🔍 回到近景' : '🗺️ 大地圖');

    this.set(
      'stock',
      v.stock.length
        ? v.stock
            .filter(isItem)
            .map((id) => `<button data-item="${id}">${this.icon(id, 'px s')}${ITEMS[id].name}</button>`)
            .join('')
        : '<span class="empty">空的。在下面的商店買道具。</span>',
    );
    const poor = Object.keys(ITEMS)
      .filter((id) => priceOf(id, this.mul) > v.money)
      .join(',');
    if (this.cache.poor !== poor) {
      this.cache.poor = poor;
      const set = new Set(poor.split(','));
      for (const b of $('items').querySelectorAll('[data-item]')) b.classList.toggle('poor', set.has(b.dataset.item));
    }

    let html = '';
    mine.forEach((m, k) => {
      const dead = m.state === 'fountain';
      const hp = dead ? '' : '♥'.repeat(Math.max(0, m.hp)) + `<i>${'♥'.repeat(Math.max(0, m.maxHp - m.hp))}</i>`;
      const buffs = (m.buffs.vision ? this.icon('scope', 'px t') : '') + (m.buffs.speed < 1 ? this.icon('boots', 'px t') : '') + (m.buffs.dig < 1 ? this.icon('pick', 'px t') : '');
      const carry = isItem(m.carry) ? `${this.icon(m.carry, 'px s')}${ITEMS[m.carry].name}` : '空手';
      const upCost = m.level < 3 ? C.upgradeCost[m.level - 1] : 0;
      const canUse = !dead && m.carry && m.carry !== 'bomb';
      const refund = C.sellBase + Math.floor(m.invested / 2);
      const at = sel.indexOf(m.id);
      const cls = `card${at >= 0 ? ' sel' : ''}${at === 0 ? ' prim' : ''}${dead ? ' dead' : ''}${isIdle(m, v) ? ' idle' : ''}`;
      html +=
        `<div class="${cls}" data-id="${m.id}">` +
        `<div class="av"><img class="px" src="${this.avatar}" alt=""><span class="num">${k + 1}</span></div>` +
        `<div class="r1"><span class="lv">Lv${m.level}</span><span class="hp">${hp}</span><span class="buffs">${buffs}</span><span class="carry">${carry}</span></div>` +
        `<div class="r2">${statusText(v, m)}</div>` +
        `<div class="r3">` +
        `<button data-act="use"${canUse ? '' : ' disabled'}>使用 E</button>` +
        `<button data-act="up"${m.level < 3 && v.money >= upCost ? '' : ' disabled'}>${m.level < 3 ? `升級 $${upCost}` : '滿級'}</button>` +
        `<button data-act="home"${dead ? ' disabled' : ''}>回家 H</button>` +
        `<button data-act="auto" class="${m.auto ? 'on' : ''}">自動 G</button>` +
        `<button data-act="sell"${mine.length > 1 ? '' : ' disabled'}>賣 $${refund}</button>` +
        `</div></div>`;
    });
    this.set('miners', html);
  }

  // 連線延遲：自己 / 對手（毫秒）；lag 是多久沒收到伺服器的畫面更新（毫秒）
  net(mine, foe, lag) {
    const el = $('netstat');
    const worst = Math.max(mine, lag > 400 ? lag : 0);
    el.classList.toggle('warn', worst >= 150 && worst < 400);
    el.classList.toggle('bad', worst >= 400);
    this.set('netstat', `📶 ${mine} ms${foe >= 0 ? ` · 對手 ${foe} ms` : ''}`);
  }

  netWarn(text) {
    const el = $('netwarn');
    el.classList.toggle('hidden', !text);
    if (text && el.textContent !== text) el.textContent = text;
  }

  // 畫面上方的操作提示（瞄準使用道具時）；給空字串就收起來
  hint(html) {
    const el = $('hint');
    el.classList.toggle('hidden', !html);
    if (html) this.set('hint', html);
    else this.cache.hint = '';
  }

  tip(text) {
    this.set('tip', text);
  }

  log(text, kind = 'info') {
    const box = $('log');
    const d = document.createElement('div');
    d.className = ['good', 'bad', 'alert'].includes(kind) ? kind : 'info';
    d.textContent = text;
    box.appendChild(d);
    while (box.children.length > 6) box.firstChild.remove();
    setTimeout(() => d.classList.add('fade'), 5000);
    setTimeout(() => d.remove(), 5700);
  }

  banner(text, kind = '') {
    const s = document.createElement('span');
    if (kind === 'alert') s.className = 'alert';
    s.textContent = text;
    $('banner').replaceChildren(s);
    clearTimeout(this.timers.banner);
    this.timers.banner = setTimeout(() => $('banner').replaceChildren(), 3200);
  }

  emote(mine, id) {
    if (!Object.hasOwn(EMOTE, id)) return;
    const el = $(mine ? 'bub-me' : 'bub-foe');
    const who = document.createElement('small');
    who.textContent = mine ? '你' : '對手';
    el.replaceChildren(who, EMOTE[id]);
    el.classList.add('show');
    const key = mine ? 'bubMe' : 'bubFoe';
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => el.classList.remove('show'), 2600);
  }

  showTaunt() {
    $('taunt').classList.remove('hidden');
    clearTimeout(this.timers.taunt);
    this.timers.taunt = setTimeout(() => $('taunt').classList.add('hidden'), 9000);
  }

  // o: { online }
  showOver(v, o) {
    $('taunt').classList.add('hidden');
    $('help').classList.add('hidden');
    $('hint').classList.add('hidden');
    const r = v.over;
    const me = v.me;
    const win = r.winner === me;
    const draw = r.winner < 0;
    $('over-title').textContent = draw ? '平手' : win ? '勝利！' : '失敗';
    $('over-title').style.color = draw ? '' : win ? '#ffd24a' : '#ff8a80';
    const a = r.lit[me];
    const b = r.lit[1 - me];
    $('over-reason').textContent =
      r.reason === 'bomb'
        ? win
          ? '你的炸彈送進了敵方的家！'
          : '敵方的炸彈炸進了你的家……'
        : r.reason === 'surrender'
          ? win
            ? '對手投降了。'
            : '你投降了。'
          : r.reason === 'disconnect'
            ? win
              ? '對手離開或斷線了。'
              : '你離開了這一局。'
            : `時間到，比視野範圍：你 ${a} 格，對手 ${b} 格。`;
    const mine = r.stats[me];
    const foe = r.stats[1 - me];
    const row = (name, x, y) => `<tr><td>${name}</td><td>${x}</td><td>${y}</td></tr>`;
    $('over-stats').innerHTML =
      '<tr><th></th><th>你</th><th>對手</th></tr>' +
      row('視野格數', a, b) +
      row('挖掉的土', mine.dug, foe.dug) +
      row('擊殺', mine.kills, foe.kills) +
      row('佔領礦井', mine.mines, foe.mines) +
      row('花掉的錢', `$${mine.spent}`, `$${foe.spent}`);
    $('to-menu').textContent = o.online ? '離開房間' : '回主選單';
    this.overStatus('', false);
    $('over').classList.remove('hidden');
  }

  // 結算畫面下方的狀態列與「再來一局」按鈕（連線時是雙方都要按）
  overStatus(text, waiting, canAgain = true) {
    $('over-status').textContent = text;
    const b = $('again');
    b.textContent = waiting ? '取消' : '再來一局';
    b.classList.toggle('primary', !waiting);
    b.disabled = !canAgain;
  }
}
