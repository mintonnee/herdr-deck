// Mock herdr API server faithful to the 0.9.x socket protocol shapes used by the plugin.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export class MockHerdr extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.calls = [];
    this.subs = new Set();
    this.state = {
      focused_pane_id: "w1:p1",
      workspaces: [
        { workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" },
        { workspace_id: "w2", number: 2, label: "웹 프론트", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "blocked" },
      ],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 2, agent_status: "working" },
        { tab_id: "w2:t1", workspace_id: "w2", number: 1, label: "main", focused: false, pane_count: 1, agent_status: "blocked" },
      ],
      agents: [
        { terminal_id: "t1", agent: "claude", agent_status: "working", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: true },
        { terminal_id: "t2", agent: "codex", agent_status: "done", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", focused: false },
        { terminal_id: "t3", agent: "claude", agent_status: "blocked", workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", focused: false },
      ],
    };
  }

  snapshot() {
    const s = this.state;
    return {
      version: "0.9.5-mock",
      protocol: 1,
      focused_workspace_id: s.agents.find((a) => a.pane_id === s.focused_pane_id)?.workspace_id,
      focused_pane_id: s.focused_pane_id,
      workspaces: s.workspaces,
      tabs: s.tabs,
      panes: s.agents.map((a) => ({ pane_id: a.pane_id, terminal_id: a.terminal_id, workspace_id: a.workspace_id, tab_id: a.tab_id, focused: a.pane_id === s.focused_pane_id, agent_status: a.agent_status, revision: 1 })),
      layouts: [],
      agents: s.agents.map((a) => ({ ...a, focused: a.pane_id === s.focused_pane_id })),
    };
  }

  push(line, filter) {
    for (const sub of this.subs) if (!filter || filter(sub)) sub.sock.write(JSON.stringify(line) + "\n");
  }

  setStatus(paneId, status) {
    const a = this.state.agents.find((x) => x.pane_id === paneId);
    a.agent_status = status;
    this.push({ event: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: status } }, (s) => s.panes.has(paneId));
  }

  addAgent(agent) {
    this.state.agents.push(agent);
    this.push({ event: "pane_created", data: { pane: { pane_id: agent.pane_id } } }, (s) => s.lifecycle);
  }

  handle(sock, msg) {
    const { id, method, params } = msg;
    this.calls.push({ method, params });
    this.emit("call", { method, params });
    const reply = (result) => sock.write(JSON.stringify({ id, result }) + "\n");
    const fail = (code, message) => sock.write(JSON.stringify({ id, error: { code, message } }) + "\n");
    switch (method) {
      case "session.snapshot":
        return reply({ type: "session_snapshot", snapshot: this.snapshot() });
      case "events.subscribe": {
        const panes = new Set();
        let lifecycle = false;
        for (const s of params.subscriptions) {
          if (s.type === "pane.agent_status_changed") {
            if (!this.state.agents.some((a) => a.pane_id === s.pane_id)) {
              fail("not_found", `pane ${s.pane_id} not found`);
              return sock.end();
            }
            panes.add(s.pane_id);
          } else lifecycle = true;
        }
        const sub = { sock, panes, lifecycle };
        this.subs.add(sub);
        sock.on("close", () => this.subs.delete(sub));
        return reply({ type: "subscription_started" });
      }
      case "agent.focus": {
        const a = this.state.agents.find((x) => x.pane_id === params.target);
        if (!a) return fail("not_found", "agent not found");
        this.state.focused_pane_id = a.pane_id;
        this.push({ event: "pane_focused", data: { pane_id: a.pane_id } }, (s) => s.lifecycle);
        return reply({ type: "ok" });
      }
      case "workspace.focus": {
        const a = this.state.agents.find((x) => x.workspace_id === params.workspace_id);
        if (a) this.state.focused_pane_id = a.pane_id;
        this.push({ event: "workspace_focused", data: { workspace_id: params.workspace_id } }, (s) => s.lifecycle);
        return reply({ type: "ok" });
      }
      case "pane.send_keys":
        return reply({ type: "ok" });
      case "server.stop":
        reply({ type: "ok" });
        setTimeout(() => this.close(), 20);
        return;
      default:
        return fail("unknown_method", method);
    }
  }

  listen() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
    this.server = net.createServer((sock) => {
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
    return new Promise((r) => this.server.listen(this.socketPath, r));
  }

  close() {
    for (const s of this.subs) s.sock.destroy();
    this.subs.clear();
    return new Promise((r) => this.server.close(() => r()));
  }
}
