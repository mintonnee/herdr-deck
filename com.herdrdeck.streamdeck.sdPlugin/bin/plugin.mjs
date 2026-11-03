// Herdr Deck — Stream Deck plugin entry point.

import { StreamDeck } from "./streamdeck.mjs";
import { HerdrSession, resolveEndpoint } from "./herdr.mjs";
import { renderAgent, renderAttention, renderWorkspace, renderOffline, renderEmpty } from "./render.mjs";
import { bringToFront, focusHerdrUi } from "./window.mjs";

const UUID = "com.herdrdeck.streamdeck";
const A = {
  agent: `${UUID}.agent`,
  attention: `${UUID}.attention`,
  workspace: `${UUID}.workspace`,
  sendkeys: `${UUID}.sendkeys`,
};

const GLOBAL_DEFAULTS = {
  bringToFront: true,
  frontend: "herdr-ui",
  herdrUiPath: "",
  terminalProcess: process.platform === "win32" ? "WindowsTerminal" : "",
  socketPath: "",
  session: "",
};

const sd = new StreamDeck();
const herdr = new HerdrSession();

/** context -> { action, settings } for every visible key. */
const keys = new Map();
/** context -> last image sent, to avoid redundant setImage traffic. */
const lastImage = new Map();
/** contexts whose property inspector is open. */
const openInspectors = new Set();

function globals() {
  return { ...GLOBAL_DEFAULTS, ...(sd.globalSettings ?? {}) };
}

function applyGlobals() {
  const g = globals();
  herdr.configure({ socketPath: g.socketPath || undefined, session: g.session || undefined });
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
  return ws?.label ?? a.workspace_id;
}

// ---- rendering --------------------------------------------------------------------

function renderKey(context) {
  const key = keys.get(context);
  if (!key) return;
  const { action, settings } = key;
  if (action === A.sendkeys) return; // uses the user's own title over the static icon

  if (!herdr.connected) {
    setImage(context, renderOffline());
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
    const blocked = agents.filter((a) => a.agent_status === "blocked").length;
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
    connected: herdr.connected,
    endpoint: resolveEndpoint(herdr.options).endpoint,
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
  else await focusHerdrUi(g.herdrUiPath);
}

async function focusPane(paneId) {
  await herdr.focusAgent(paneId);
  await raiseFrontend();
}

async function onKeyDown(context) {
  const key = keys.get(context);
  if (!key) return;
  const { action, settings } = key;
  try {
    if (!herdr.connected) await herdr.refresh();
    if (!herdr.connected) throw new Error("herdr is not running");

    if (action === A.agent) {
      const a = agentForKey(settings);
      if (!a) throw new Error("no agent in this slot");
      await focusPane(a.pane_id);
    } else if (action === A.attention) {
      let queue = herdr.attentionQueue();
      if (settings.includeDone === false) queue = queue.filter((a) => a.agent_status === "blocked");
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
      let paneId = herdr.focusedPaneId();
      if (settings.target === "pane" && settings.paneId) paneId = settings.paneId;
      else if (settings.target === "slot") paneId = agentForKey({ slot: settings.slot })?.pane_id;
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

herdr.on("update", renderAll);

sd.connect();
applyGlobals();
herdr.start();
