// 遊戲伺服器：提供網頁檔案，並用 WebSocket 跑雙人對戰（房間、對局、帳號）。
// 只用 Node 內建模組，不需要安裝任何套件。
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './src/server/ws.js';
import { Lobby } from './src/server/lobby.js';
import { Accounts } from './src/server/accounts.js';
import { VERSION } from './src/version.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 5173;
// 預設讓同一個區域網路的電腦也連得進來；加上 --local（或設 HOST=127.0.0.1）就只有這台電腦連得到
const host = process.argv.includes('--local') ? '127.0.0.1' : process.env.HOST || '0.0.0.0';
// 放在雲端主機上（Render 會自動設 RENDER；其他主機可以加 --cloud 或設 CLOUD=1）：
// 不顯示區域網路網址，並且信任主機前面那一層轉送過來的玩家 IP
const cloud = !!process.env.RENDER || process.env.CLOUD === '1' || process.argv.includes('--cloud');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const MAX_CONNS = Number(process.env.MAX_CONNS) || 400;
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP) || 12;
const url = `http://localhost:${port}`;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// 這台電腦在區域網路上的網址，給另一位玩家用
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

// 加上 --open 時（start.bat 會加），伺服器準備好之後自己打開預設瀏覽器。
function openBrowser() {
  if (!process.argv.includes('--open')) return;
  try {
    const opts = { detached: true, stdio: 'ignore' };
    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '""', url], { ...opts, windowsVerbatimArguments: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts);
    child.on('error', () => {});
    child.unref();
  } catch {
    // 打不開瀏覽器沒關係，網址已經印在視窗裡了
  }
}

// 只提供遊戲需要的檔案；伺服器程式與帳號資料不對外
const allowed = (rel) => rel === '/index.html' || rel === '/style.css' || (rel.startsWith('/src/') && !rel.startsWith('/src/server/'));

const server = http.createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('ok');
      return;
    }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(root, rel));
    if (!allowed(rel) || !file.startsWith(root + path.sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

const accounts = new Accounts(path.join(dataDir, 'accounts.json'));
const lobby = new Lobby({ accounts, version: VERSION, addrs: cloud || host === '127.0.0.1' || host === 'localhost' ? [] : lanUrls() });

// 連線數上限：全部加起來、以及同一個 IP，避免被灌爆
const perIp = new Map();
let conns = 0;
function clientIp(req) {
  if (cloud) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}
attachWebSocket(server, '/ws', (conn, req) => {
  const ip = clientIp(req);
  const n = perIp.get(ip) || 0;
  if (conns >= MAX_CONNS || n >= MAX_CONNS_PER_IP) {
    conn.close(1013);
    return;
  }
  conns++;
  perIp.set(ip, n + 1);
  lobby.connect(conn);
  const onclose = conn.onclose;
  conn.onclose = () => {
    conns--;
    const left = (perIp.get(ip) || 1) - 1;
    if (left > 0) perIp.set(ip, left);
    else perIp.delete(ip);
    onclose();
  };
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`連接埠 ${port} 已經有人在用，遊戲可能已經在執行了，直接開 ${url} 就可以。`);
    openBrowser();
    process.exit(0);
  }
  throw err;
});

server.listen(port, host, () => {
  setInterval(() => lobby.tick(), 20);
  console.log(`Nerf Miner ${VERSION} 已啟動（關掉這個視窗就會停止）`);
  console.log(`  這台電腦：${url}`);
  for (const a of lobby.addrs) console.log(`  同一個網路的另一台電腦：${a}`);
  openBrowser();
});

// 關閉前把帳號資料寫完
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    accounts.flush().finally(() => process.exit(0));
  });
}
