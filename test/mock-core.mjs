// Mock herdr-core: JSON-RPC 2.0 in plain mode, shaped like schema/hc.openrpc.json.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

const tree = (...terminals) => ({
  id: "",
  type: "row",
  children: terminals.map((t) => ({ id: `p-${t}`, type: "block", content: { terminal: t } })),
});

export class MockCore extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.calls = [];
    this.subs = new Set();
    this.seq = 0;
    this.terminals = [
      { address: "t1", name: null, argv: ["claude"], cwd: "/home/u/api", state: "live", reported: true, status: { state: "working", app: "claude", msg: "", title: "" }, parent: null },
      { address: "t2", name: "reviewer", argv: ["codex"], cwd: "/home/u/api", state: "live", reported: true, status: { state: "done", app: "codex", msg: "", title: "" }, parent: null },
      { address: "t3", name: null, argv: ["/bin/zsh"], cwd: "/home/u/web", state: "live", reported: false, status: null, parent: null },
      { address: "t4", name: null, argv: ["claude"], cwd: "/home/u/web", state: "live", reported: true, status: { state: "blocked", app: "claude", kind: "permission", msg: "", title: "" }, parent: null },
      // A sub-agent without a pane: shown under its parent's space.
      { address: "t5", name: "helper", argv: ["pi"], cwd: "/home/u/web", state: "live", reported: true, status: { state: "error", app: "pi", msg: "", title: "" }, parent: "t4" },
    ];
    this.doc = {
      version: 3,
      value: {
        spaces: [
          { id: "s1", name: "api", folder: "/home/u/api", tabs: [{ id: "c1", name: "", root: tree("t1", "t2") }] },
          { id: "s2", name: "", folder: "/home/u/web", tabs: [{ id: "c2", name: "main", root: tree("t3") }, { id: "c3", name: "agents", root: tree("t4") }] },
        ],
      },
    };
  }

  notify(type, terminal, data) {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: ++this.seq, type, terminal, data } }) + "\n";
    for (const s of this.subs) s.write(line);
  }

  setStatus(address, state) {
    const t = this.terminals.find((x) => x.address === address);
    t.status = state ? { state, app: t.status?.app ?? "agent", msg: "", title: "" } : null;
    t.reported = true;
    this.notify("status", address, { status: t.status, records: {}, reported: true });
  }

  renameSpace(id, name) {
    this.doc.value.spaces.find((s) => s.id === id).name = name;
    this.doc.version++;
    this.notify("doc", null, { name: "herdr-app", version: this.doc.version });
  }

  handle(sock, msg) {
    const { id, method, params } = msg;
    this.calls.push({ method, params });
    this.emit("call", { method, params });
    const reply = (result) => sock.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    const fail = (kind, message) =>
      sock.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { kind, hint: "" } } }) + "\n");
    switch (method) {
      case "hello":
        return reply({ version: "0.9.0-mock", generation: 1, framed: false, features: [], methods: [], core: {} });
      case "terminal.list":
        return reply({ terminals: this.terminals, hidden_finished: 0, machines: [] });
      case "doc.get":
        if (params.name !== "herdr-app") return reply({ value: null, version: 0 });
        return reply({ value: this.doc.value, version: this.doc.version });
      case "events.subscribe":
        this.subs.add(sock);
        sock.on("close", () => this.subs.delete(sock));
        return reply({ seq: this.seq, terminals: this.terminals, channel: null });
      case "terminal.keys":
        if (!this.terminals.some((t) => t.address === params.terminal)) return fail("not_found", `no terminal ${params.terminal}`);
        return reply({ status: "idle", turn: 1 });
      case "server.status":
        return reply({ version: "0.9.0-mock", pid: process.pid, live: this.terminals.length, finished: 0, uptime_ms: 1 });
      case "server.stop":
        reply({ stopped: true });
        setTimeout(() => this.close(), 20);
        return;
      default:
        return fail("usage", `unknown method ${method}`);
    }
  }

  listen() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
    this.sockets = new Set();
    this.server = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.on("close", () => this.sockets.delete(sock));
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (c) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) this.handle(sock, JSON.parse(line));
        }
      });
      sock.on("error", () => {});
    });
    this.listening = true;
    return new Promise((r) => this.server.listen(this.socketPath, r));
  }

  close() {
    if (!this.listening) return Promise.resolve();
    this.listening = false;
    for (const s of this.sockets) s.destroy();
    this.subs.clear();
    return new Promise((r) => this.server.close(() => r()));
  }
}
