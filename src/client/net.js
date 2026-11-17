// 和伺服器的連線：自動重連、每 2 秒量一次延遲。
import { VERSION } from '../version.js';

const mem = (store, k, v) => {
  try {
    if (v === undefined) return store.getItem(k);
    if (v === null) store.removeItem(k);
    else store.setItem(k, v);
  } catch {
    // 瀏覽器不讓存就當作沒有
  }
  return null;
};
export const saved = {
  get: (k) => mem(localStorage, k),
  set: (k, v) => mem(localStorage, k, v),
};

function randomId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Net {
  // on.msg(m)：收到伺服器訊息；on.state(s)：連線狀態改變（'off' | 'connecting' | 'on'）
  constructor(on) {
    this.on = on;
    this.ws = null;
    this.state = 'off';
    this.want = false;
    this.rtt = 0;
    this.retry = 0;
    this.pingTimer = null;
    this.lastMsg = 0;
    // 每個分頁一個代號，斷線重連時伺服器靠它認人
    this.cid = mem(sessionStorage, 'nm_cid') || randomId();
    mem(sessionStorage, 'nm_cid', this.cid);
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.on.state?.(s);
  }

  connect() {
    this.want = true;
    if (!this.ws) this.open();
  }

  open() {
    this.setState('connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', cid: this.cid, name: saved.get('nm_name') || '', token: saved.get('nm_token') || undefined, v: VERSION }));
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      this.lastMsg = performance.now();
      this.handle(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.setState('off');
      if (!this.want) return;
      this.retry++;
      setTimeout(() => {
        if (this.want && !this.ws) this.open();
      }, Math.min(5000, 400 * this.retry));
    };
    ws.onerror = () => {};
  }

  handle(m) {
    if (m.t === 'welcome') {
      // 伺服器版本比這個分頁新：重新整理拿新版（同一個版本只自動重整一次，避免無限重整）
      if (m.v !== VERSION && mem(sessionStorage, 'nm_reloaded') !== m.v) {
        mem(sessionStorage, 'nm_reloaded', m.v);
        location.reload();
        return;
      }
      this.retry = 0;
      this.cid = m.cid;
      mem(sessionStorage, 'nm_cid', m.cid);
      this.setState('on');
      clearInterval(this.pingTimer);
      const ping = () => this.send({ t: 'ping', ts: performance.now(), rtt: this.rtt });
      this.pingTimer = setInterval(ping, 2000);
      ping();
    } else if (m.t === 'pong') {
      this.rtt = Math.round(performance.now() - m.ts);
      return;
    }
    this.on.msg(m);
  }

  send(o) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  }

  close() {
    this.want = false;
    if (this.ws) this.ws.close();
  }
}
