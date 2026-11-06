// Herdr Deck — Stream Deck plugin entry point.

import { StreamDeck } from "./streamdeck.mjs";
import { HerdrSession, resolveEndpoint, needsYou } from "./herdr.mjs";
import { CoreSession } from "./core.mjs";
import { renderAgent, renderAttention, renderWorkspace, renderOffline, renderEmpty, renderPower } from "./render.mjs";
import { bringToFront, focusHerdrUi } from "./window.mjs";
import { raiseHerdrApp, startCore, startHerdrServer } from "./apps.mjs";

const UUID = "com.herdrdeck.streamdeck";
const A = {
  agent: `${UUID}.agent`,
  attention: `${UUID}.attention`,
  workspace: `${UUID}.workspace`,
  sendkeys: `${UUID}.sendkeys`,
  power: `${UUID}.power`,
};

const GLOBAL_DEFAULTS = {
  backend: "herdr", // "herdr" (herdr's socket API) or "core" (herdr-core)
  bringToFront: true,
  frontend: "herdr-ui",
  herdrUiPath: "",
  herdrAppPath: "",
  hcPath: "",
  herdrPath: "",
  terminalProcess: process.platform === "win32" ? "WindowsTerminal" : "",
  socketPath: "",
  session: "",
};

const sd = new StreamDeck();
let herdr = null;
let backend = null;

/** context -> { action, settings } for every visible key. */
const keys = new Map();
/** context -> last image sent, to avoid redundant setImage traffic. */
const lastImage = new Map();
/** contexts whose property inspector is open. */
const openInspectors = new Set();
/** power key context -> { busy: "starting…" | "stopping…" | null, confirmUntil, timer }. */
const power = new Map();

function globals() {
  return { ...GLOBAL_DEFAULTS, ...(sd.globalSettings ?? {}) };
}

function isCore() {
  return backend === "core";
}

function sessionOptions(g) {
  return {
    socketPath: g.socketPath || undefined,
    session: g.session || undefined,
    herdrAppPath: g.herdrAppPath || undefined,
  };
}

function applyGlobals() {
  const g = globals();
  const want = g.backend === "core" ? "core" : "herdr";
  if (want !== backend) {
    herdr?.stop();
    herdr?.removeAllListeners("update");
    backend = want;
    herdr = want === "core" ? new CoreSession(sessionOptions(g)) : new HerdrSession(sessionOptions(g));
    herdr.on("update", renderAll);
    herdr.start();
    renderAll();
  } else {
    herdr.configure(sessionOptions(g));
  }
}

function setImage(context, image) {
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  sd.setImage(context, image);
}

// ---- resolving what a key points at -------------------------------------------

function agentForKey(settings) {
  const agents = herdr.agentsOrdered();
  if (settings.mode === "pane" && settings.paneId) {
    return agents.find((a) => a.pane_id === settings.paneId) ?? null;
  }
  const slot = Math.max(1, parseInt(settings.slot ?? 1, 10) || 1);
  return agents[slot - 1] ?? null;
}

function workspaceForKey(settings) {
  const list = herdr.workspacesOrdered();
  if (settings.mode === "id" && settings.workspaceId) {
    return list.find((w) => w.workspace_id === settings.workspaceId) ?? null;
  }
  const slot = Math.max(1, parseInt(settings.slot ?? 1, 10) || 1);
  return list[slot - 1] ?? null;
}

function agentName(a) {
  return a.name || a.display_agent || a.agent || "agent";
}

function agentSubtitle(a) {
  const ws = herdr.workspace(a.workspace_id);
  const tab = herdr.tab(a.tab_id);
  if (ws && tab && (ws.tab_count ?? 1) > 1 && tab.label) return `${ws.label} · ${tab.label}`;
  return ws?.label ?? a.location ?? a.workspace_id ?? "";
}

function backendName() {
  const g = globals();
  const base = isCore() ? "herdr-core" : "herdr";
  return g.session ? `${base} · ${g.session}` : base;
}

// ---- rendering --------------------------------------------------------------------

function renderPowerKey(context) {
  const p = power.get(context) ?? {};
  const name = backendName();
  if (p.busy) return setImage(context, renderPower({ state: "busy", name, detail: p.busy }));
  if (herdr.connected && p.confirmUntil > Date.now()) {
    return setImage(context, renderPower({ state: "confirm", name, detail: "again: stop" }));
  }
  if (herdr.connected) {
    const n = herdr.agentsOrdered().length;
    return setImage(context, renderPower({ state: "on", name, detail: n ? `ON · ${n}` : "ON" }));
  }
  setImage(context, renderPower({ state: "off", name, detail: "OFF" }));
}

function renderKey(context) {
  const key = keys.get(context);
  if (!key) return;
  const { action, settings } = key;
  if (action === A.sendkeys) return; // uses the user's own title over the static icon
  if (action === A.power) return renderPowerKey(context);

  if (!herdr.connected) {
    setImage(context, renderOffline(isCore() ? "herdr-core" : "herdr"));
    return;
  }

  if (action === A.agent) {
    const a = agentForKey(settings);
    if (!a) {
      const label = settings.mode === "pane" ? "pane gone" : `slot ${settings.slot ?? 1}`;
      setImage(context, renderEmpty(label));
      return;
    }
    setImage(
      context,
      renderAgent({
        status: a.agent_status,
        name: agentName(a),
        sub: agentSubtitle(a),
        focused: a.pane_id === herdr.focusedPaneId(),
        slotLabel: settings.mode === "pane" ? "" : String(settings.slot ?? 1),
      }),
    );
  } else if (action === A.attention) {
    const agents = herdr.agentsOrdered();
    const blocked = agents.filter((a) => needsYou(a.agent_status)).length;
    const done = settings.includeDone === false ? 0 : agents.filter((a) => a.agent_status === "done").length;
    setImage(context, renderAttention({ blocked, done, total: agents.length }));
  } else if (action === A.workspace) {
    const w = workspaceForKey(settings);
    if (!w) {
      setImage(context, renderEmpty(settings.mode === "id" ? "ws gone" : `ws slot ${settings.slot ?? 1}`));
      return;
    }
    const agents = herdr.agentsOrdered().filter((a) => a.workspace_id === w.workspace_id).length;
    setImage(
      context,
      renderWorkspace({
        status: w.agent_status,
        label: w.label,
        number: w.number,
        focused: !!w.focused,
        agents,
      }),
    );
  }
}

function renderAll() {
  for (const context of keys.keys()) renderKey(context);
  for (const context of openInspectors) pushOptions(context);
}

// ---- property inspector data --------------------------------------------------------

function endpointLabel() {
  if (!isCore()) return resolveEndpoint(herdr.options).endpoint;
  const info = herdr.endpointInfo;
  return info.endpoint ? `${info.endpoint} (${info.source})` : `error: ${info.error}`;
}

function pushOptions(context) {
  const key = keys.get(context);
  if (!key) return;
  const agents = herdr.agentsOrdered().map((a, i) => ({
    pane_id: a.pane_id,
    slot: i + 1,
    label: `${i + 1}. ${agentName(a)} — ${agentSubtitle(a)} (${a.pane_id})`,
    status: a.agent_status,
  }));
  const workspaces = herdr.workspacesOrdered().map((w, i) => ({
    workspace_id: w.workspace_id,
    slot: i + 1,
    label: `${i + 1}. ${w.label} (#${w.number})`,
  }));
  sd.sendToPropertyInspector(key.action, context, {
    type: "options",
    backend,
    backendName: isCore() ? "herdr-core" : "herdr",
    connected: herdr.connected,
    endpoint: endpointLabel(),
    lastError: herdr.lastError,
    version: herdr.snapshot?.version ?? null,
    agents,
    workspaces,
    globals: globals(),
  });
}

// ---- key presses ---------------------------------------------------------------------

async function raiseFrontend() {
  const g = globals();
  if (!g.bringToFront) return;
  if (g.frontend === "terminal") bringToFront(g.terminalProcess);
  // herdr-core terminals are shown by the Herdr app.
  else if (isCore() || g.frontend === "herdr-app") await raiseHerdrApp(g.herdrAppPath || undefined);
  else await focusHerdrUi(g.herdrUiPath);
}

async function focusPane(paneId) {
  await herdr.focusAgent(paneId);
  await raiseFrontend();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Re-read until the session is (or is no longer) reachable. */
async function waitConnected(want, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await herdr.refresh();
    if (herdr.connected === want) return true;
    await sleep(300);
  }
  return false;
}

async function onPowerKey(context, settings) {
  const p = power.get(context) ?? {};
  power.set(context, p);
  if (p.busy) return;
  const g = globals();
  await herdr.refresh();

  if (herdr.connected) {
    // Stopping ends every program in the session: ask for a second press.
    if (settings.confirmStop !== false && !(p.confirmUntil > Date.now())) {
      p.confirmUntil = Date.now() + 3000;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => renderPowerKey(context), 3100);
      return renderPowerKey(context);
    }
    p.confirmUntil = 0;
    p.busy = "stopping…";
    renderPowerKey(context);
    try {
      await herdr.serverStop().catch((err) => {
        // The server may drop the connection as it goes down.
        if (!["closed", "ECONNRESET", "EPIPE"].includes(err.code)) throw err;
      });
      if (!(await waitConnected(false, 15000))) throw new Error("server is still running");
      sd.showOk(context);
    } finally {
      p.busy = null;
      renderAll();
    }
    return;
  }

  p.busy = "starting…";
  renderPowerKey(context);
  try {
    const opts = { session: g.session || undefined, socketPath: g.socketPath || undefined };
    if (isCore()) await startCore({ ...opts, hcPath: g.hcPath || undefined });
    else await startHerdrServer({ ...opts, herdrPath: g.herdrPath || undefined });
    if (!(await waitConnected(true, 20000))) throw new Error("server did not come up");
    herdr.restart();
    sd.showOk(context);
  } finally {
    p.busy = null;
    renderAll();
  }
}

async function onKeyDown(context) {
  const key = keys.get(context);
  if (!key) return;
  const { action, settings } = key;
  try {
    if (action === A.power) return await onPowerKey(context, settings);

    if (!herdr.connected) await herdr.refresh();
    if (!herdr.connected) throw new Error(`${isCore() ? "herdr-core" : "herdr"} is not running`);

    if (action === A.agent) {
      const a = agentForKey(settings);
      if (!a) throw new Error("no agent in this slot");
      await focusPane(a.pane_id);
    } else if (action === A.attention) {
      let queue = herdr.attentionQueue();
      if (settings.includeDone === false) queue = queue.filter((a) => needsYou(a.agent_status));
      if (!queue.length) {
        sd.showOk(context);
        return;
      }
      // Cycle: go to the entry after the currently focused pane, else the most urgent.
      const focused = herdr.focusedPaneId();
      const idx = queue.findIndex((a) => a.pane_id === focused);
      const next = idx >= 0 ? queue[(idx + 1) % queue.length] : queue[0];
      await focusPane(next.pane_id);
    } else if (action === A.workspace) {
      const w = workspaceForKey(settings);
      if (!w) throw new Error("no workspace in this slot");
      await herdr.focusWorkspace(w.workspace_id);
      await raiseFrontend();
    } else if (action === A.sendkeys) {
      const list = String(settings.keys ?? "esc")
        .split(/[\s,]+/)
        .map((k) => k.trim())
        .filter(Boolean);
      if (!list.length) throw new Error("no keys configured");
      let paneId;
      if (settings.target === "pane" && settings.paneId) paneId = settings.paneId;
      else if (settings.target === "slot") paneId = agentForKey({ slot: settings.slot })?.pane_id;
      else paneId = herdr.currentFocus ? await herdr.currentFocus() : herdr.focusedPaneId();
      if (!paneId) throw new Error("no target pane");
      await herdr.sendKeys(paneId, list);
      sd.showOk(context);
    }
  } catch (err) {
    sd.log(`[herdr-deck] ${action} failed: ${err.message}`);
    sd.showAlert(context);
  }
}

// ---- Stream Deck events ------------------------------------------------------------------

sd.on("willAppear", (msg) => {
  keys.set(msg.context, { action: msg.action, settings: msg.payload?.settings ?? {} });
  lastImage.delete(msg.context);
  if (msg.action !== A.sendkeys) sd.setTitle(msg.context, "");
  renderKey(msg.context);
});

sd.on("willDisappear", (msg) => {
  keys.delete(msg.context);
  lastImage.delete(msg.context);
  openInspectors.delete(msg.context);
  clearTimeout(power.get(msg.context)?.timer);
  power.delete(msg.context);
});

sd.on("didReceiveSettings", (msg) => {
  const key = keys.get(msg.context);
  if (key) key.settings = msg.payload?.settings ?? {};
  else keys.set(msg.context, { action: msg.action, settings: msg.payload?.settings ?? {} });
  lastImage.delete(msg.context);
  renderKey(msg.context);
});

sd.on("didReceiveGlobalSettings", () => {
  applyGlobals();
  renderAll();
});

sd.on("keyDown", (msg) => onKeyDown(msg.context));

sd.on("propertyInspectorDidAppear", (msg) => {
  openInspectors.add(msg.context);
  pushOptions(msg.context);
});

sd.on("propertyInspectorDidDisappear", (msg) => openInspectors.delete(msg.context));

sd.on("sendToPlugin", (msg) => {
  const payload = msg.payload ?? {};
  if (payload.type === "getOptions") pushOptions(msg.context);
  if (payload.type === "reconnect") {
    herdr.restart();
    herdr.refresh();
  }
});

applyGlobals();
sd.connect();
