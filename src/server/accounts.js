// 帳號與戰績。資料存在一個 JSON 檔裡（data/accounts.json）：
// 密碼只存加鹽的 scrypt 雜湊，登入憑證只存 SHA-256 雜湊，檔案裡沒有任何明碼。
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NAME_RE = /^[\p{L}\p{N}_]{2,12}$/u;
const MAX_TOKENS = 5;
const MAX_FAILS = 8;
const BLOCK_MS = 5 * 60 * 1000;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const derive = (pass, salt) => new Promise((ok, no) => scrypt(pass, salt, 64, (e, k) => (e ? no(e) : ok(k))));

export class Accounts {
  constructor(file = null) {
    this.file = file;
    this.users = new Map(); // 小寫名字 → 帳號
    this.tokens = new Map(); // 憑證雜湊 → 小寫名字
    this.fails = new Map(); // 來源位址 → { n, until }
    this.timer = null;
    this.writing = Promise.resolve();
    if (!file) return;
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      for (const u of Array.isArray(d.users) ? d.users : []) {
        if (!u || typeof u.name !== 'string' || typeof u.hash !== 'string' || typeof u.salt !== 'string') continue;
        u.tokens = Array.isArray(u.tokens) ? u.tokens.filter((t) => typeof t === 'string') : [];
        for (const k of ['wins', 'losses', 'draws']) u[k] = Number.isFinite(u[k]) ? u[k] : 0;
        const key = u.name.toLowerCase();
        this.users.set(key, u);
        for (const t of u.tokens) this.tokens.set(t, key);
      }
    } catch {
      // 檔案不存在或壞掉：從空的開始
    }
  }

  blocked(ip) {
    const f = this.fails.get(ip);
    return !!f && f.until > Date.now();
  }

  fail(ip) {
    const f = this.fails.get(ip) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= MAX_FAILS) {
      f.n = 0;
      f.until = Date.now() + BLOCK_MS;
    }
    this.fails.set(ip, f);
  }

  check(name, pass) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return '名字要 2–12 個字，只能用文字、數字和底線。';
    if (typeof pass !== 'string' || pass.length < 6 || pass.length > 64) return '密碼要 6–64 個字。';
    return null;
  }

  issue(user) {
    const token = randomBytes(24).toString('hex');
    const h = sha(token);
    user.tokens.push(h);
    while (user.tokens.length > MAX_TOKENS) this.tokens.delete(user.tokens.shift());
    this.tokens.set(h, user.name.toLowerCase());
    this.save();
    return token;
  }

  async register(name, pass, ip = '') {
    if (this.blocked(ip)) return { ok: false, error: '嘗試太多次了，請 5 分鐘後再試。' };
    const bad = this.check(name, pass);
    if (bad) return { ok: false, error: bad };
    const key = name.toLowerCase();
    if (this.users.has(key)) return { ok: false, error: '這個名字已經有人用了。' };
    const salt = randomBytes(16);
    const hash = await derive(pass, salt);
    if (this.users.has(key)) return { ok: false, error: '這個名字已經有人用了。' };
    const user = { name, salt: salt.toString('hex'), hash: hash.toString('hex'), tokens: [], wins: 0, losses: 0, draws: 0, created: Date.now() };
    this.users.set(key, user);
    return { ok: true, token: this.issue(user), user: this.info(name) };
  }

  async login(name, pass, ip = '') {
    if (this.blocked(ip)) return { ok: false, error: '嘗試太多次了，請 5 分鐘後再試。' };
    const user = typeof name === 'string' ? this.users.get(name.toLowerCase()) : null;
    let good = false;
    if (user && typeof pass === 'string' && pass.length <= 64) {
      const hash = await derive(pass, Buffer.from(user.salt, 'hex'));
      const want = Buffer.from(user.hash, 'hex');
      good = hash.length === want.length && timingSafeEqual(hash, want);
    }
    if (!good) {
      this.fail(ip);
      return { ok: false, error: '名字或密碼不對。' };
    }
    return { ok: true, token: this.issue(user), user: this.info(user.name) };
  }

  byToken(token) {
    if (typeof token !== 'string' || token.length > 200) return null;
    const key = this.tokens.get(sha(token));
    return key ? this.users.get(key) || null : null;
  }

  logout(token) {
    if (typeof token !== 'string') return;
    const h = sha(token);
    const key = this.tokens.get(h);
    if (!key) return;
    this.tokens.delete(h);
    const user = this.users.get(key);
    if (user) user.tokens = user.tokens.filter((t) => t !== h);
    this.save();
  }

  info(name) {
    const u = typeof name === 'string' ? this.users.get(name.toLowerCase()) : null;
    return u ? { name: u.name, wins: u.wins, losses: u.losses, draws: u.draws } : null;
  }

  // result: 'win' | 'loss' | 'draw'
  record(name, result) {
    const u = typeof name === 'string' ? this.users.get(name.toLowerCase()) : null;
    if (!u) return;
    if (result === 'win') u.wins++;
    else if (result === 'loss') u.losses++;
    else u.draws++;
    this.save();
  }

  top(n = 10) {
    return [...this.users.values()]
      .filter((u) => u.wins + u.losses + u.draws > 0)
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.created - b.created)
      .slice(0, n)
      .map((u) => ({ name: u.name, wins: u.wins, losses: u.losses, draws: u.draws }));
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
    this.timer.unref?.();
  }

  // 先寫暫存檔再改名，寫到一半當機也不會弄壞原本的檔案
  flush() {
    if (!this.file) return Promise.resolve();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const body = JSON.stringify({ users: [...this.users.values()] }, null, 1);
    this.writing = this.writing
      .then(async () => {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, body, 'utf8');
        await rename(tmp, this.file);
      })
      .catch((e) => console.error('帳號資料存檔失敗：', e.message));
    return this.writing;
  }
}
