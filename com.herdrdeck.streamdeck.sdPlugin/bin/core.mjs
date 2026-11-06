// herdr-core (`hc`) client: JSON-RPC 2.0, one message per line, over the core's
// Unix socket or Windows named pipe ("plain mode"). Presents the same view as
// HerdrSession (agents, workspaces, attention) so every key works on either.
//
// Terminals and their status come from the core. Spaces and tabs belong to the
// Herdr app, which keeps them in the core as the "herdr-app" document; focusing
// and showing a space go through the app (apps.mjs), since the core draws nothing.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { HerdrSession } from "./herdr.mjs";
import { herdrAppDo, herdrAppFocusedTerminal } from "./apps.mjs";

const SESSION_BAD = /[\u0000-\u001f\u007f/\\:*?"<>|]/;

/** The `socket` setting in herdr-core's config.toml, or null. */
export function configSocket(text) {
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) return null; // only top-level keys count
    const m = line.match(/^socket\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/);
    if (!m) continue;
    if (m[1].startsWith("'")) return m[1].slice(1, -1) || null;
    try {
      return JSON.parse(m[1]) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Where herdr-core listens, by the core's own rules (paths.rs, Paths::from_env):
 * HC_SOCKET, else `socket` in config.toml, else the default:
 *   Unix:    $XDG_RUNTIME_DIR/herdr-core/<session>.sock, else /run/user/<uid>/herdr-core/,
 *            else beside the state: ~/.local/state/herdr-core/<session>/<session>.sock
 *   Windows: \\.\pipe\herdr-core-<USERNAME>-<session>.sock
 * A socket path set in the plugin wins over all of them.
 */
export function coreEndpoint(options = {}, ctx = {}) {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const home = ctx.home ?? os.homedir();
  const p = platform === "win32" ? path.win32 : path.posix;
  const readFile = ctx.readFile ?? ((f) => fs.readFileSync(f, "utf8"));
  const isDir = ctx.isDir ?? ((d) => fs.statSync(d, { throwIfNoEntry: false })?.isDirectory() ?? false);
  const uid = ctx.uid ?? (process.getuid ? process.getuid() : 0);
  const get = (k) => (env[k] ? String(env[k]) : "");

  const session = String(options.session || get("HC_SESSION") || "").trim() || "default";
  if (session === "." || session === ".." || SESSION_BAD.test(session)) {
    throw Object.assign(new Error(`session ${JSON.stringify(session)} can't be a folder name`), { code: "usage" });
  }
  let stateHome, configHome;
  if (platform === "win32") {
    const profile = get("USERPROFILE") || home;
    stateHome = get("XDG_STATE_HOME") || get("LOCALAPPDATA") || p.join(profile, "AppData", "Local");
    configHome = get("XDG_CONFIG_HOME") || get("APPDATA") || p.join(profile, "AppData", "Roaming");
  } else {
    const h = get("HOME") || home;
    stateHome = get("XDG_STATE_HOME") || p.join(h, ".local", "state");
    configHome = get("XDG_CONFIG_HOME") || p.join(h, ".config");
  }
  const state = p.join(stateHome, "herdr-core", session);
  const config = p.join(configHome, "herdr-core", "config.toml");

  let endpoint = options.socketPath || "";
  let source = endpoint ? "setting" : "";
  if (!endpoint && get("HC_SOCKET")) [endpoint, source] = [get("HC_SOCKET"), "HC_SOCKET"];
  if (!endpoint) {
    let text = "";
    try {
      text = readFile(config);
    } catch {}
    const fromConfig = configSocket(text);
    if (fromConfig) [endpoint, source] = [fromConfig, "config"];
  }
  if (!endpoint) {
    source = "default";
    if (platform === "win32") {
      const user = get("USERNAME").replace(/[^A-Za-z0-9]/g, "");
      endpoint = `\\\\.\\pipe\\herdr-core-${user}-${session}.sock`;
    } else {
      let run = get("XDG_RUNTIME_DIR");
      if (!run && isDir(`/run/user/${uid}`)) run = `/run/user/${uid}`;
      endpoint = run ? p.join(run, "herdr-core", `${session}.sock`) : p.join(state, `${session}.sock`);
    }
  }
  return { endpoint, source, session, state, config, lock: p.join(state, "core.lock") };
}

/**
 * The endpoint to dial. On Unix a running core writes where it really listens
 * into <state>/core.lock; when that differs from what this process's env says
 * (Stream Deck doesn't load shell profiles), follow the core. Windows locks
 * that file, and its pipe names don't depend on the env anyway.
 */
export function resolveCoreEndpoint(options = {}, ctx = {}) {
  const info = coreEndpoint(options, ctx);
  const platform = ctx.platform ?? process.platform;
  if (platform !== "win32" && info.source !== "setting") {
    try {
      const actual = (ctx.readFile ?? ((f) => fs.readFileSync(f, "utf8")))(info.lock).trim();
      const exists = ctx.exists ?? ((f) => fs.existsSync(f));
      if (actual && actual !== info.endpoint && exists(actual) && !exists(info.endpoint)) {
        return { ...info, endpoint: actual, source: "core.lock" };
      }
    } catch {}
  }
  return info;
}

let rpcCounter = 0;

/** One JSON-RPC call over a fresh connection. Rejects with an Error whose `.code` is the core's error kind. */
export function coreRequest(endpoint, method, params = {}, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const id = ++rpcCounter;
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
    const timer = setTimeout(() => done(Object.assign(new Error(`herdr-core ${method} timed out`), { code: "timeout" })), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
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
        if (msg.id !== id) continue;
        if (msg.error) {
          const e = new Error(msg.error.message || "herdr-core error");
          e.code = msg.error.data?.kind || msg.error.code;
          e.hint = msg.error.data?.hint;
          return done(e);
        }
        return done(null, msg.result);
      }
    });
    sock.on("error", (err) => done(err));
    sock.on("close", () => done(Object.assign(new Error(`herdr-core connection closed during ${method}`), { code: "closed" })));
  });
}

// ---- herdr-app document -> workspaces/tabs ------------------------------------------

/** Terminal addresses shown in a tab's layout tree, in tree order. */
export function terminalsInTree(node, out = []) {
  if (!node || typeof node !== "object") return out;
  const t = node.content?.terminal;
  if (typeof t === "string" && t) out.push(t);
  for (const child of node.children ?? []) terminalsInTree(child, out);
  for (const float of node.floating ?? []) {
    const ft = float?.content?.terminal;
    if (typeof ft === "string" && ft) out.push(ft);
  }
  return out;
}

const URGENCY = { blocked: 0, error: 0, done: 1, working: 2, idle: 3, unknown: 4 };
const KNOWN = new Set(["idle", "working", "done", "blocked", "error"]);

function basename(p) {
  return String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

/** A core terminal as one of the plugin's agents, or null for a plain shell. */
function agentOf(t) {
  if (t.state && t.state !== "live") return null;
  if (!t.status && !t.reported) return null;
  const state = t.status?.state;
  return {
    pane_id: t.address,
    terminal_id: t.address,
    name: t.name || t.status?.app || basename(t.argv?.[0]) || t.address,
    agent: t.status?.app || basename(t.argv?.[0]),
    agent_status: KNOWN.has(state) ? state : "unknown",
    parent: t.parent ?? null,
    location: basename(t.foreground?.cwd || t.cwd) || null,
    workspace_id: null,
    tab_id: null,
  };
}

/**
 * Builds a snapshot shaped like herdr's session.snapshot from core terminals and
 * the Herdr app's layout document, so the derived views in HerdrSession apply.
 */
export function buildSnapshot({ terminals = [], doc = null, version = null, focused = null }) {
  const agents = terminals.map(agentOf).filter(Boolean);
  const byAddr = new Map(terminals.map((t) => [t.address, t]));
  const placed = new Map(); // terminal -> { workspace_id, tab_id, order }
  const workspaces = [];
  const tabs = [];
  let order = 0;
  for (const [si, space] of (Array.isArray(doc?.spaces) ? doc.spaces : []).entries()) {
    if (!space?.id) continue;
    const spaceTabs = Array.isArray(space.tabs) ? space.tabs : [];
    let firstCwd = null;
    for (const [ti, tab] of spaceTabs.entries()) {
      const tabId = tab?.id || `${space.id}:${ti + 1}`;
      tabs.push({ tab_id: tabId, workspace_id: space.id, number: ti + 1, label: tab?.name || String(ti + 1) });
      for (const addr of terminalsInTree(tab?.root)) {
        if (!placed.has(addr)) placed.set(addr, { workspace_id: space.id, tab_id: tabId, order: order++ });
        const t = byAddr.get(addr);
        firstCwd ??= t?.foreground?.cwd || t?.cwd || null;
      }
    }
    workspaces.push({
      workspace_id: space.id,
      number: si + 1,
      // Herdr names an unnamed space after where its first terminal is.
      label: space.name || basename(firstCwd) || basename(space.folder) || `space ${si + 1}`,
      tab_count: spaceTabs.length,
      agent_status: "unknown",
      focused: false,
    });
  }
  // Sub-agents have no pane of their own: they belong where their parent is.
  const placeOf = (addr, seen = new Set()) => {
    if (placed.has(addr)) return placed.get(addr);
    const parent = byAddr.get(addr)?.parent;
    if (!parent || seen.has(addr)) return null;
    seen.add(addr);
    return placeOf(parent, seen);
  };
  const ranked = agents.map((a, i) => {
    const place = placeOf(a.pane_id);
    if (place) Object.assign(a, { workspace_id: place.workspace_id, tab_id: place.tab_id });
    return { a, key: place ? place.order : Number.MAX_SAFE_INTEGER, i };
  });
  ranked.sort((x, y) => x.key - y.key || x.i - y.i);
  const ordered = ranked.map((r) => r.a);
  for (const w of workspaces) {
    const mine = ordered.filter((a) => a.workspace_id === w.workspace_id);
    if (mine.length) w.agent_status = mine.map((a) => a.agent_status).sort((x, y) => URGENCY[x] - URGENCY[y])[0];
  }
  const focusedAgent = ordered.find((a) => a.pane_id === focused);
  for (const w of workspaces) w.focused = !!focusedAgent && focusedAgent.workspace_id === w.workspace_id;
  return {
    version,
    backend: "herdr-core",
    focused_pane_id: focusedAgent ? focused : null,
    workspaces,
    tabs,
    panes: ordered.map((a) => ({ pane_id: a.pane_id, workspace_id: a.workspace_id, tab_id: a.tab_id })),
    agents: ordered,
  };
}

// ---- live session ----------------------------------------------------------------------

/** Live view of a herdr-core session, with HerdrSession's derived views and commands. */
export class CoreSession extends HerdrSession {
  constructor(options = {}) {
    super(options);
    this.coreVersion = null;
    this.lastFocused = null;
    this.lastMessageAt = 0;
    this.watchdog = null;
  }

  get endpointInfo() {
    try {
      return resolveCoreEndpoint(this.options);
    } catch (err) {
      return { endpoint: "", error: err.message, source: "error" };
    }
  }

  get endpoint() {
    return this.endpointInfo.endpoint;
  }

  request(method, params, timeoutMs) {
    const { endpoint, error } = this.endpointInfo;
    if (!endpoint) return Promise.reject(Object.assign(new Error(error || "no herdr-core endpoint"), { code: "usage" }));
    return coreRequest(endpoint, method, params, timeoutMs);
  }

  start() {
    super.start();
    clearInterval(this.watchdog);
    // The core sends a heartbeat every 15 s; silence past that means a dead link.
    this.watchdog = setInterval(() => {
      if (this.subSock && this.lastMessageAt && Date.now() - this.lastMessageAt > 40000) this.subSock.destroy();
    }, 5000);
  }

  stop() {
    clearInterval(this.watchdog);
    super.stop();
  }

  connectSubscription() {
    if (this.stopped) return;
    const endpoint = this.endpoint;
    if (!endpoint) {
      this.lastError = this.endpointInfo.error;
      this.setDisconnected();
      setTimeout(() => this.connectSubscription(), 5000);
      return;
    }
    const id = ++rpcCounter;
    const sock = net.connect(endpoint);
    this.subSock = sock;
    this.lastMessageAt = Date.now(); // the watchdog times this connection, not the last one
    let buf = "";
    let started = false;
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id, method: "events.subscribe", params: {} }) + "\n");
    });
    sock.on("data", (chunk) => {
      this.lastMessageAt = Date.now();
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
        if (msg.id === id) {
          if (msg.error) {
            this.lastError = msg.error.data?.kind || msg.error.message;
            sock.destroy();
            continue;
          }
          started = true;
          this.backoffMs = 1000;
          this.scheduleRefresh(0);
          continue;
        }
        if (msg.method === "heartbeat") continue;
        // event or missed: the authoritative read follows.
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
      if (!started) {
        this.setDisconnected();
        const wait = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 5000);
        setTimeout(() => this.connectSubscription(), wait);
      } else {
        // Core stopped, restarted (hc update) or the link died.
        this.scheduleRefresh(0);
        setTimeout(() => this.connectSubscription(), 250);
      }
    });
  }

  async refresh() {
    this.refreshInFlight = true;
    this.lastRefreshAt = Date.now();
    try {
      if (!this.coreVersion) {
        const hello = await this.request("hello", {}, 4000);
        this.coreVersion = hello?.version ?? "?";
      }
      const [list, doc] = await Promise.all([
        this.request("terminal.list", {}, 4000),
        // Spaces and tabs exist only when the Herdr app has saved its layout.
        this.request("doc.get", { name: "herdr-app" }, 4000).catch(() => null),
      ]);
      this.snapshot = buildSnapshot({
        terminals: list?.terminals ?? [],
        doc: doc?.value ?? null,
        version: this.coreVersion,
        focused: this.lastFocused,
      });
      this.connected = true;
      this.lastError = null;
      this.emit("update", this);
    } catch (err) {
      this.lastError = err.code || err.message;
      this.coreVersion = null;
      this.setDisconnected();
    } finally {
      this.refreshInFlight = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }

  // ---- commands (the core draws nothing: showing goes through the Herdr app) ----

  async focusAgent(address) {
    await herdrAppDo(this.options.herdrAppPath, "agent.focus", { terminal: address });
    this.lastFocused = address;
    this.scheduleRefresh(0);
  }

  async focusWorkspace(spaceId) {
    await herdrAppDo(this.options.herdrAppPath, "space.select", { id: spaceId });
    const first = this.agentsOrdered().find((a) => a.workspace_id === spaceId);
    if (first) this.lastFocused = first.pane_id;
    this.scheduleRefresh(0);
  }

  /** The terminal the Herdr window has focused, else the last one this plugin jumped to. */
  async currentFocus() {
    const shown = await herdrAppFocusedTerminal(this.options.herdrAppPath).catch(() => null);
    if (shown) this.lastFocused = shown;
    return shown ?? this.focusedPaneId();
  }

  async sendKeys(address, keys) {
    // The core holds keys until nobody has typed for ~3 s, so allow for that.
    await this.request("terminal.keys", { terminal: address, keys }, 15000);
  }

  serverStatus() {
    return this.request("server.status", {}, 4000);
  }

  serverStop() {
    return this.request("server.stop", {}, 15000);
  }
}
