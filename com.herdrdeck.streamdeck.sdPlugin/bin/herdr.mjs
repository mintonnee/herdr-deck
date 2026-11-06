// herdr socket API client: newline-delimited JSON over a local socket
// (Windows named pipe / Unix domain socket). Keeps a live session snapshot
// using events.subscribe as an invalidation signal, per herdr's docs:
// subscribe first, then reconcile with authoritative session.snapshot reads.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const IS_WIN = process.platform === "win32";

/** Default herdr API socket file path (mirrors herdr's config_dir()). */
export function defaultSocketFile(session) {
  let base;
  if (process.env.XDG_CONFIG_HOME) base = path.join(process.env.XDG_CONFIG_HOME, "herdr");
  else if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    base = path.join(appData, "herdr");
  } else base = path.join(os.homedir(), ".config", "herdr");
  if (session) base = path.join(base, "sessions", session);
  return path.join(base, "herdr.sock");
}

/**
 * Resolve the path to hand to net.connect().
 * On Windows herdr binds a named pipe called `\\.\pipe\<socket file path>`
 * and writes a marker file at the socket path itself.
 */
export function resolveEndpoint({ socketPath, session } = {}) {
  const file = socketPath || process.env.HERDR_SOCKET_PATH || defaultSocketFile(session);
  if (IS_WIN) {
    if (file.startsWith("\\\\.\\pipe\\")) return { file, endpoint: file };
    return { file, endpoint: `\\\\.\\pipe\\${file}` };
  }
  return { file, endpoint: file };
}

let reqCounter = 0;

/** One request over a fresh connection. Resolves with `result`, rejects with an Error carrying `.code`. */
export function herdrRequest(endpoint, method, params = {}, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const id = `sd_${process.pid}_${++reqCounter}`;
    const sock = net.connect(endpoint);
    let buf = "";
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => {
      const e = new Error(`herdr ${method} timed out`);
      e.code = "timeout";
      done(e);
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id && msg.id !== "") continue;
        if (msg.error) {
          const e = new Error(msg.error.message || msg.error.code || "herdr error");
          e.code = msg.error.code;
          return done(e);
        }
        return done(null, msg.result);
      }
    });
    sock.on("error", (err) => done(err));
    sock.on("close", () => {
      const e = new Error(`herdr connection closed during ${method}`);
      e.code = "closed";
      done(e);
    });
  });
}

const LIFECYCLE_EVENTS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
];

const STATUS_RANK = { blocked: 0, error: 0, done: 1, working: 2, idle: 3, unknown: 4 };

/** Statuses that wait on the person: herdr's blocked, and herdr-core's error too. */
export function needsYou(status) {
  return status === "blocked" || status === "error";
}

/**
 * Live view of a herdr session.
 * Emits "update" (state) whenever the snapshot or connection status changes.
 */
export class HerdrSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.connected = false;
    this.lastError = null;
    this.snapshot = null;
    this.subSock = null;
    this.subscribedPaneKey = "";
    this.refreshInFlight = false;
    this.refreshAgain = false;
    this.refreshTimer = null;
    this.lastRefreshAt = 0;
    this.stopped = true; // until start()
    this.backoffMs = 1000;
    this.pollTimer = null;
    this.rejectStreak = 0;
  }

  configure(options) {
    const before = JSON.stringify(this.options);
    this.options = { ...this.options, ...options };
    if (JSON.stringify(this.options) !== before) this.restart();
  }

  get endpoint() {
    return resolveEndpoint(this.options).endpoint;
  }

  request(method, params, timeoutMs) {
    return herdrRequest(this.endpoint, method, params, timeoutMs);
  }

  start() {
    this.stopped = false;
    this.connectSubscription();
    // Safety net: periodic authoritative refresh even if an event is missed.
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      const fast = this.rejectStreak >= 2 || !this.subSock;
      if (fast || Date.now() - this.lastRefreshAt > (this.options.pollMs ?? 5000)) this.scheduleRefresh(0);
    }, 1000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.refreshTimer);
    this.subSock?.destroy();
    this.subSock = null;
  }

  restart() {
    this.subSock?.destroy();
    this.subSock = null;
    this.subscribedPaneKey = "";
    if (!this.stopped) this.connectSubscription();
  }

  agentPaneIds() {
    return (this.snapshot?.agents ?? []).map((a) => a.pane_id).sort();
  }

  connectSubscription() {
    if (this.stopped) return;
    const paneIds = this.agentPaneIds();
    // If per-pane status subscriptions keep getting rejected, fall back to
    // lifecycle events + faster polling instead of looping.
    const statusPaneIds = this.rejectStreak >= 2 ? [] : paneIds;
    const subscriptions = [
      ...LIFECYCLE_EVENTS.map((type) => ({ type })),
      ...statusPaneIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    ];
    const id = `sd_sub_${Date.now()}`;
    const sock = net.connect(this.endpoint);
    this.subSock = sock;
    this.subscribedPaneKey = paneIds.join(",");
    let buf = "";
    let started = false;
    let rejected = false;
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === id && msg.result?.type === "subscription_started") {
          started = true;
          this.backoffMs = 1000;
          if (statusPaneIds.length) this.rejectStreak = 0;
          // Subscribed: now take the authoritative read.
          this.scheduleRefresh(0);
          continue;
        }
        if (msg.error) {
          // events_lost, or a pane vanished between snapshot and subscribe.
          // The server is alive; it closes this connection and we resubscribe.
          this.lastError = msg.error.code || msg.error.message;
          rejected = true;
          this.rejectStreak++;
          continue;
        }
        // Any pushed event invalidates the cache.
        this.scheduleRefresh();
      }
    });
    sock.on("error", (err) => {
      this.lastError = err.code || err.message;
    });
    sock.on("close", () => {
      if (this.subSock !== sock) return; // replaced intentionally
      this.subSock = null;
      if (this.stopped) return;
      if (rejected) {
        // Re-read the session (pane ids may have changed), then resubscribe.
        this.subscribedPaneKey = "";
        this.refresh().finally(() => setTimeout(() => this.connectSubscription(), 300));
      } else if (!started) {
        this.setDisconnected();
        const wait = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 5000);
        setTimeout(() => this.connectSubscription(), wait);
      } else {
        // Lost a working subscription (events_lost, server restart, pane set changed).
        setTimeout(() => this.connectSubscription(), 250);
      }
    });
  }

  setDisconnected() {
    if (this.connected || this.snapshot) {
      this.connected = false;
      this.snapshot = null;
      this.emit("update", this);
    } else {
      this.emit("update", this);
    }
  }

  /** Coalesce refreshes; at most ~5 snapshot reads per second. */
  scheduleRefresh(delay) {
    if (this.stopped) return;
    if (this.refreshInFlight) {
      this.refreshAgain = true;
      return;
    }
    if (this.refreshTimer) return;
    const minGap = 200;
    const since = Date.now() - this.lastRefreshAt;
    const wait = delay ?? Math.max(60, minGap - since);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, wait);
  }

  async refresh() {
    this.refreshInFlight = true;
    this.lastRefreshAt = Date.now();
    try {
      const result = await this.request("session.snapshot", {}, 4000);
      const snap = result?.snapshot ?? result;
      this.snapshot = snap;
      this.connected = true;
      this.lastError = null;
      // Agent set changed → resubscribe so per-pane status events cover every agent.
      if (this.subSock && this.agentPaneIds().join(",") !== this.subscribedPaneKey) {
        this.rejectStreak = 0;
        this.restart();
      }
      this.emit("update", this);
    } catch (err) {
      this.lastError = err.code || err.message;
      this.setDisconnected();
    } finally {
      this.refreshInFlight = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }

  // ---- derived views -------------------------------------------------------

  workspacesOrdered() {
    const ws = [...(this.snapshot?.workspaces ?? [])];
    ws.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    return ws;
  }

  /** Agents in visual order: workspace number, tab number, then server order. */
  agentsOrdered() {
    const snap = this.snapshot;
    if (!snap) return [];
    const wsNum = new Map((snap.workspaces ?? []).map((w) => [w.workspace_id, w.number ?? 0]));
    const tabNum = new Map((snap.tabs ?? []).map((t) => [t.tab_id, t.number ?? 0]));
    return (snap.agents ?? [])
      .map((a, i) => ({ a, i }))
      .sort(
        (x, y) =>
          (wsNum.get(x.a.workspace_id) ?? 0) - (wsNum.get(y.a.workspace_id) ?? 0) ||
          (tabNum.get(x.a.tab_id) ?? 0) - (tabNum.get(y.a.tab_id) ?? 0) ||
          x.i - y.i,
      )
      .map(({ a }) => a);
  }

  workspace(id) {
    return (this.snapshot?.workspaces ?? []).find((w) => w.workspace_id === id);
  }

  tab(id) {
    return (this.snapshot?.tabs ?? []).find((t) => t.tab_id === id);
  }

  /** Agents needing the user, most urgent first (blocked/error, then done). */
  attentionQueue() {
    return this.agentsOrdered()
      .filter((a) => needsYou(a.agent_status) || a.agent_status === "done")
      .sort((x, y) => STATUS_RANK[x.agent_status] - STATUS_RANK[y.agent_status]);
  }

  focusedPaneId() {
    return this.snapshot?.focused_pane_id ?? null;
  }

  serverStop() {
    return this.request("server.stop", {}, 10000);
  }

  // ---- commands --------------------------------------------------------------

  async focusAgent(paneId) {
    try {
      await this.request("agent.focus", { target: paneId });
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "timeout") throw err;
      // Fall back to focusing the pane's workspace, tab and pane explicitly.
      const pane = (this.snapshot?.panes ?? []).find((p) => p.pane_id === paneId);
      if (!pane) throw err;
      await this.request("workspace.focus", { workspace_id: pane.workspace_id });
      await this.request("tab.focus", { tab_id: pane.tab_id });
      await this.request("pane.focus", { pane_id: paneId });
    }
    this.scheduleRefresh(0);
  }

  async focusWorkspace(workspaceId) {
    await this.request("workspace.focus", { workspace_id: workspaceId });
    this.scheduleRefresh(0);
  }

  async sendKeys(paneId, keys) {
    await this.request("pane.send_keys", { pane_id: paneId, keys });
  }
}

/** True when the socket marker/file exists (Windows writes a marker file at the socket path). */
export function socketFileExists(options) {
  try {
    return fs.existsSync(resolveEndpoint(options).file);
  } catch {
    return false;
  }
}
