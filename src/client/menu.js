// 對局以外的畫面：主選單、單人設定、大廳、房間、帳號。
import { CHARS, CHAR_IDS } from '../sim/chars.js';
import { VERSION } from '../version.js';
import { saved } from './net.js';
import { esc } from './ui.js';
import { audio } from './audio.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['menu', 'solo', 'lobby', 'room', 'howto'];
const charOf = (id) => (CHAR_IDS.includes(id) ? id : 'digger');

export class Menu {
  // o: { net, sprites, onSolo(level, char) }
  constructor(o) {
    this.net = o.net;
    this.sp = o.sprites;
    this.onSolo = o.onSolo;
    this.char = charOf(saved.get('nm_char'));
    this.name = saved.get('nm_name') || '';
    this.user = null; // 登入的帳號 { name, wins, losses, draws }
    this.room = null; // 伺服器最後送來的房間狀態
    this.addrs = [];
    this.inGame = false;
    this.current = 'menu';
    this.avatars = new Map();
    this.cdTimer = null;
    this.toastTimer = null;
    this.pendingJoin = new URLSearchParams(location.search).get('room');
    this.bind();
    this.renderChars();
    this.renderAcct();
    this.syncSound();
    $('ver').textContent = `v${VERSION}`;
    if (this.pendingJoin) {
      history.replaceState(null, '', location.pathname);
      // 等主程式把選單建好再連線（連線狀態的回呼會用到選單）
      setTimeout(() => this.goVersus(), 0);
    }
  }

  avatar(team, char) {
    const k = `${team}${char}`;
    if (!this.avatars.has(k)) this.avatars.set(k, this.sp.avatar(team, charOf(char), 4));
    return this.avatars.get(k);
  }

  displayName() {
    return this.user ? this.user.name : this.name;
  }

  // 顯示某個畫面；null 表示全部收起來（進入對局）
  show(name) {
    this.current = name;
    for (const s of SCREENS) $(s).classList.toggle('hidden', s !== name);
    if (name !== 'room') this.stopCountdown();
    if (name === 'room') this.renderRoom();
  }

  bind() {
    const net = this.net;
    $('go-solo').addEventListener('click', () => this.show('solo'));
    $('go-versus').addEventListener('click', () => this.goVersus());
    $('go-howto').addEventListener('click', () => this.show('howto'));
    for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => this.show('menu'));
    $('solo').addEventListener('click', (e) => {
      const b = e.target.closest('[data-level]');
      if (b) this.onSolo(b.dataset.level, this.char);
    });
    for (const id of ['solo-chars', 'room-chars']) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('[data-char]');
        if (!b) return;
        this.char = charOf(b.dataset.char);
        saved.set('nm_char', this.char);
        this.renderChars();
        if (this.room) net.send({ t: 'char', id: this.char });
        audio.play('click');
      });
    }
    $('btn-create').addEventListener('click', () => net.send({ t: 'create' }));
    $('btn-quick').addEventListener('click', () => net.send({ t: 'quick' }));
    const join = () => {
      const code = $('join-code').value.trim();
      if (code) net.send({ t: 'join', code });
    };
    $('btn-join').addEventListener('click', join);
    $('join-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    $('btn-ready').addEventListener('click', () => {
      const r = this.room;
      if (r) net.send({ t: 'ready', on: !r.players[r.you].ready });
      audio.play('click');
    });
    $('btn-leave').addEventListener('click', () => net.send({ t: 'leave' }));
    $('invite').addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') return;
      e.target.select();
      navigator.clipboard?.writeText(e.target.value).then(
        () => this.toast('已複製邀請連結'),
        () => {},
      );
    });

    // 帳號列（主選單和大廳各有一個）
    for (const id of ['acct', 'lobby-acct']) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('[data-acct]');
        if (!b || b.tagName !== 'BUTTON') return;
        if (b.dataset.acct === 'login') {
          net.connect();
          $('auth-err').textContent = '';
          $('auth').classList.remove('hidden');
          $('auth-name').focus();
        } else if (b.dataset.acct === 'logout') {
          net.send({ t: 'logout' });
        }
      });
      $(id).addEventListener('change', (e) => {
        if (e.target.dataset.acct !== 'name') return;
        this.name = e.target.value.trim().slice(0, 12);
        saved.set('nm_name', this.name || null);
        if (this.name) net.send({ t: 'name', name: this.name });
      });
    }
    const auth = (kind) => {
      const name = $('auth-name').value.trim();
      const pass = $('auth-pass').value;
      if (net.state !== 'on') {
        $('auth-err').textContent = '還沒連上伺服器，請稍等一下再試。';
        return;
      }
      $('auth-err').textContent = '';
      net.send({ t: kind, name, pass });
    };
    $('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      auth('login');
    });
    $('auth-register').addEventListener('click', () => auth('register'));
    $('auth-cancel').addEventListener('click', () => $('auth').classList.add('hidden'));

    for (const b of document.querySelectorAll('.snd-sfx')) {
      b.addEventListener('click', () => {
        audio.setSfx(!audio.sfxOn);
        this.syncSound();
        audio.play('click');
      });
    }
    for (const b of document.querySelectorAll('.snd-music')) {
      b.addEventListener('click', () => {
        audio.setMusic(!audio.musicOn);
        this.syncSound();
      });
    }
  }

  syncSound() {
    for (const b of document.querySelectorAll('.snd-sfx')) {
      b.classList.toggle('off', !audio.sfxOn);
      b.textContent = audio.sfxOn ? '🔊' : '🔇';
    }
    for (const b of document.querySelectorAll('.snd-music')) b.classList.toggle('off', !audio.musicOn);
  }

  goVersus() {
    this.show(this.room ? 'room' : 'lobby');
    this.net.connect();
    this.onNetState(this.net.state);
    if (this.net.state === 'on') this.net.send({ t: 'top' });
  }

  toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  // ---------- 繪製 ----------

  renderAcct() {
    const u = this.user;
    const html = u
      ? `<span class="who">👤 ${esc(u.name)}</span><span class="rec">${u.wins} 勝 ${u.losses} 敗 ${u.draws} 平</span><button data-acct="logout">登出</button>`
      : `<span class="who">訪客</span><input data-acct="name" maxlength="12" placeholder="你的暱稱" value="${esc(this.name)}"><button data-acct="login">登入 / 註冊</button>`;
    $('acct').innerHTML = html;
    $('lobby-acct').innerHTML = html;
  }

  renderChars() {
    const draw = (id, team) => {
      $(id).innerHTML = CHAR_IDS.map(
        (c) =>
          `<button class="char${c === this.char ? ' sel' : ''}" data-char="${c}"><img src="${this.avatar(team, c)}" alt=""><span class="cn">${CHARS[c].name}</span><span class="cp">${CHARS[c].perk}</span></button>`,
      ).join('');
    };
    draw('solo-chars', 0);
    draw('room-chars', this.room ? this.room.you : 0);
  }

  renderRoom() {
    const r = this.room;
    if (!r) return;
    $('room-code').textContent = r.code;
    const full = r.players.length === 2;
    $('room-hint').textContent = !full
      ? r.open
        ? '快速配對中，等其他玩家加入…'
        : '把房號或下面的連結給朋友，等他加入。'
      : r.state === 'countdown'
        ? '馬上開始！'
        : '雙方都按「準備好了」就開始。';
    if (full) $('invite').innerHTML = '';
    else {
      const here = `${location.origin}/?room=${r.code}`;
      const lan = this.addrs.map((a) => `${a}/?room=${r.code}`).filter((u) => u !== here);
      const local = /^(localhost|127\.|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
      $('invite').innerHTML =
        (lan.length ? `同一個 Wi-Fi／區域網路的另一台電腦開這個網址：<br>${lan.map((u) => `<input readonly value="${esc(u)}">`).join('<br>')}<br>` : '') +
        `${local ? '同一台電腦可以開新分頁' : '把這個連結傳給朋友'}：<br><input readonly value="${esc(here)}">`;
    }
    let html = '';
    for (let k = 0; k < 2; k++) {
      const p = r.players[k];
      if (!p) {
        html += '<div class="player empty">等待對手加入…</div>';
        continue;
      }
      const c = charOf(p.char);
      html +=
        `<div class="player t${k}"><img src="${this.avatar(k, c)}" alt=""><div>` +
        `<div class="pn">${esc(p.name)}${k === r.you ? '<span class="you">你</span>' : ''}</div>` +
        `<div class="ps">${CHARS[c].name}${p.rec ? ` · ${p.rec.wins} 勝 ${p.rec.losses} 敗` : ''}</div>` +
        `<div class="ps${p.ready ? ' ok' : ''}">${!p.on ? '斷線中' : p.ready ? '✔ 準備好了' : '還沒準備'}</div>` +
        `</div></div>`;
    }
    $('players').innerHTML = html;
    const mine = r.players[r.you];
    const b = $('btn-ready');
    b.textContent = mine.ready ? '取消準備' : '準備好了';
    b.classList.toggle('primary', !mine.ready);
    this.char = charOf(mine.char);
    this.renderChars();
    if (r.state === 'countdown' && this.current === 'room') this.startCountdown(r.cd);
    else this.stopCountdown();
  }

  startCountdown(ms) {
    this.stopCountdown();
    const end = performance.now() + ms;
    const el = $('countdown');
    let shown = 0;
    const tick = () => {
      const n = Math.max(1, Math.ceil((end - performance.now()) / 1000));
      if (n !== shown) {
        shown = n;
        el.textContent = String(n);
        audio.play('tick');
      }
    };
    el.classList.remove('hidden');
    tick();
    this.cdTimer = setInterval(tick, 100);
  }

  stopCountdown() {
    clearInterval(this.cdTimer);
    this.cdTimer = null;
    $('countdown').classList.add('hidden');
  }

  // ---------- 連線 ----------

  onNetState(s) {
    $('lobby-status').textContent = s === 'on' ? '已連上伺服器，選一種方式開始。' : s === 'connecting' ? '連線中…' : '連不上伺服器，正在重試…';
    for (const id of ['btn-create', 'btn-quick', 'btn-join']) $(id).disabled = s !== 'on';
    if (s !== 'on' && this.current === 'room' && !this.inGame) {
      // 還沒開打就斷線：房間已經不在了
      this.room = null;
      this.show('lobby');
    }
  }

  onMsg(m) {
    switch (m.t) {
      case 'welcome':
        this.user = m.user;
        if (!m.user && !this.name) this.name = m.name;
        this.addrs = Array.isArray(m.addrs) ? m.addrs : [];
        this.renderAcct();
        this.onNetState('on');
        this.net.send({ t: 'top' });
        if (this.pendingJoin) {
          this.net.send({ t: 'join', code: this.pendingJoin });
          this.pendingJoin = null;
        }
        break;
      case 'me':
        this.user = m.user;
        if (!m.user) this.name = m.name;
        this.renderAcct();
        break;
      case 'auth':
        if (!m.ok) {
          $('auth-err').textContent = m.error || '失敗了，請再試一次。';
          break;
        }
        this.user = m.user;
        if (!m.user) this.name = '';
        saved.set('nm_token', m.token || null);
        $('auth-pass').value = '';
        $('auth').classList.add('hidden');
        this.renderAcct();
        this.net.send({ t: 'top' });
        break;
      case 'top': {
        const list = Array.isArray(m.list) ? m.list : [];
        $('top').innerHTML = list.length
          ? list.map((u) => `<li>${esc(u.name)}<span>${u.wins} 勝 ${u.losses} 敗</span></li>`).join('')
          : '<li class="small">還沒有戰績。登入後打完一局就會出現在這裡。</li>';
        break;
      }
      case 'room':
        this.room = m;
        if (!this.inGame) this.show('room');
        break;
      case 'left':
        this.room = null;
        if (!this.inGame) {
          this.show('lobby');
          this.net.send({ t: 'top' });
        }
        break;
      case 'error':
        this.toast(m.msg || '出錯了');
        break;
    }
  }
}
