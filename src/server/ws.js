// 最小的 WebSocket 伺服器（RFC 6455），只用 Node 內建模組，所以遊戲不用安裝任何套件。
// 只支援文字訊息；單則訊息上限 64 KB。
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 1 << 16;

export function acceptKey(key) {
  return createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

// mask：4 bytes 的遮罩（只有瀏覽器送給伺服器的方向需要，測試用）
export function encodeFrame(data, opcode = 1, mask = null) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export class FrameParser {
  constructor(max = MAX_MESSAGE, requireMask = true) {
    this.buf = Buffer.alloc(0);
    this.max = max;
    this.requireMask = requireMask;
  }

  // 丟進收到的位元組，回傳目前湊齊的 frame；格式不對就丟出錯誤
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      if (b[0] & 0x70) throw new Error('reserved bits');
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      if (this.requireMask && !masked) throw new Error('unmasked frame');
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.max)) throw new Error('message too big');
        len = Number(big);
        off = 10;
      }
      if (len > this.max) throw new Error('message too big');
      if (opcode >= 8 && (len > 125 || !fin)) throw new Error('bad control frame');
      const start = off + (masked ? 4 : 0);
      if (b.length < start + len) break;
      const payload = Buffer.allocUnsafe(len);
      if (masked) {
        for (let i = 0; i < len; i++) payload[i] = b[start + i] ^ b[off + (i & 3)];
      } else {
        b.copy(payload, 0, start, start + len);
      }
      frames.push({ fin, opcode, payload });
      this.buf = b.subarray(start + len);
    }
    return frames;
  }
}

export class WSConn {
  constructor(socket, ip = '') {
    this.socket = socket;
    this.ip = ip;
    this.open = true;
    this.dead = false;
    this.onmessage = null;
    this.onclose = null;
    this.lastSeen = Date.now();
    this.parser = new FrameParser();
    this.parts = null;
    this.partsLen = 0;
    socket.on('data', (d) => this.feed(d));
    socket.on('close', () => this.shut());
    socket.on('error', () => this.shut());
  }

  feed(chunk) {
    if (!this.open) return;
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch {
      this.close(1002);
      return;
    }
    this.lastSeen = Date.now();
    for (const f of frames) {
      if (!this.open) return;
      this.frame(f);
    }
  }

  frame(f) {
    switch (f.opcode) {
      case 0: // 分段訊息的後續
        if (!this.parts) return this.close(1002);
        this.parts.push(f.payload);
        this.partsLen += f.payload.length;
        if (this.partsLen > MAX_MESSAGE) return this.close(1009);
        if (f.fin) {
          const all = Buffer.concat(this.parts);
          this.parts = null;
          this.deliver(all);
        }
        break;
      case 1:
        if (this.parts) return this.close(1002);
        if (f.fin) this.deliver(f.payload);
        else {
          this.parts = [f.payload];
          this.partsLen = f.payload.length;
        }
        break;
      case 8:
        this.close(1000);
        break;
      case 9:
        this.socket.write(encodeFrame(f.payload, 10));
        break;
      case 10:
        break;
      default: // 不支援二進位訊息與未知的 opcode
        this.close(1003);
    }
  }

  deliver(buf) {
    if (this.onmessage) this.onmessage(buf.toString('utf8'));
  }

  send(text) {
    if (!this.open) return;
    // 對方太久沒收資料（緩衝堆太多）就直接斷線，免得吃光記憶體
    if (this.socket.writableLength > 4 << 20) return this.close(1008);
    this.socket.write(encodeFrame(text));
  }

  // 送一個 WebSocket ping：瀏覽器會自動回 pong（就算分頁在背景、計時器被放慢也會回），用來確認對方還在
  ping() {
    if (this.open) this.socket.write(encodeFrame('', 9));
  }

  close(code = 1000) {
    if (!this.open) return;
    this.open = false;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code);
    try {
      this.socket.write(encodeFrame(b, 8));
      this.socket.end();
    } catch {
      // 連線已經壞了
    }
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.shut();
  }

  shut() {
    if (this.dead) return;
    this.dead = true;
    this.open = false;
    if (this.onclose) this.onclose();
  }
}

// 把 WebSocket 接到 http 伺服器上：瀏覽器連 ws://主機/路徑 時呼叫 onConnection(conn)。
export function attachWebSocket(server, path, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    let ok = false;
    try {
      ok =
        req.method === 'GET' &&
        new URL(req.url, 'http://localhost').pathname === path &&
        /websocket/i.test(req.headers.upgrade || '') &&
        typeof req.headers['sec-websocket-key'] === 'string' &&
        req.headers['sec-websocket-version'] === '13';
    } catch {
      ok = false;
    }
    if (!ok) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);
    const conn = new WSConn(socket, req.socket.remoteAddress || '');
    onConnection(conn, req);
    if (!conn.open) return; // 被拒絕（例如連線數太多）
    if (head && head.length) conn.feed(head);
  });
}
