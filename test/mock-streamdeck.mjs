// Minimal WebSocket server standing in for the Stream Deck app (text frames only).
import http from "node:http";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

function encodeFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export class MockStreamDeck extends EventEmitter {
  constructor() {
    super();
    this.received = [];
    this.socket = null;
  }

  listen() {
    this.server = http.createServer();
    this.server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"];
      const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.socket = socket;
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          const masked = buf[1] & 0x80;
          const maskOff = off;
          if (masked) off += 4;
          if (buf.length < off + len) return;
          let data = buf.subarray(off, off + len);
          if (masked) {
            const mask = buf.subarray(maskOff, maskOff + 4);
            data = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
          }
          buf = buf.subarray(off + len);
          if (op === 1) {
            const msg = JSON.parse(data.toString("utf8"));
            this.received.push(msg);
            this.emit("msg", msg);
          }
        }
      });
      socket.on("error", () => {});
      this.emit("connection");
    });
    return new Promise((r) => this.server.listen(0, "127.0.0.1", () => r(this.server.address().port)));
  }

  send(obj) {
    this.socket.write(encodeFrame(JSON.stringify(obj)));
  }

  close() {
    this.socket?.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}
