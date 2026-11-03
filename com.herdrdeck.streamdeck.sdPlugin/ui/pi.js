// Shared property-inspector glue (no dependencies).
// Each page declares inputs with data-setting="name" (per-key settings) or
// data-global="name" (plugin-wide settings), and may define window.onOptions(payload).

(function () {
  let ws = null;
  let uuid = null;
  let actionUUID = null;
  let settings = {};
  let globals = {};
  let lastOptions = null;

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function readInput(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number") return el.value === "" ? "" : Number(el.value);
    return el.value;
  }

  function writeInput(el, value) {
    if (value === undefined) return;
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = value;
  }

  function fill() {
    document.querySelectorAll("[data-setting]").forEach((el) => {
      const name = el.dataset.setting;
      if (settings[name] === undefined && el.dataset.default !== undefined) {
        settings[name] = el.type === "checkbox" ? el.dataset.default === "true" : el.dataset.default;
      }
      writeInput(el, settings[name]);
    });
    document.querySelectorAll("[data-global]").forEach((el) => writeInput(el, globals[el.dataset.global]));
    syncVisibility();
  }

  function syncVisibility() {
    document.querySelectorAll("[data-show-when]").forEach((el) => {
      const [name, value] = el.dataset.showWhen.split("=");
      el.style.display = String(settings[name] ?? "") === value ? "" : "none";
    });
  }

  function saveSettings() {
    send({ event: "setSettings", context: uuid, payload: settings });
    syncVisibility();
  }

  function saveGlobals() {
    send({ event: "setGlobalSettings", context: uuid, payload: globals });
  }

  function wire() {
    document.querySelectorAll("[data-setting]").forEach((el) => {
      el.addEventListener("change", () => {
        settings[el.dataset.setting] = readInput(el);
        saveSettings();
      });
    });
    document.querySelectorAll("[data-global]").forEach((el) => {
      el.addEventListener("change", () => {
        globals[el.dataset.global] = readInput(el);
        saveGlobals();
      });
    });
    const reconnect = document.getElementById("reconnect");
    if (reconnect)
      reconnect.addEventListener("click", () =>
        send({ event: "sendToPlugin", action: actionUUID, context: uuid, payload: { type: "reconnect" } }),
      );
  }

  /** Replace a <select>'s options, keeping the current setting selected. */
  window.setSelectOptions = function (selectId, items, valueKey, settingName) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const current = settings[settingName] ?? "";
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = items.length ? "— choose —" : "(none found)";
    sel.appendChild(blank);
    let found = false;
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item[valueKey];
      opt.textContent = item.label;
      if (item[valueKey] === current) found = true;
      sel.appendChild(opt);
    }
    if (current && !found) {
      const opt = document.createElement("option");
      opt.value = current;
      opt.textContent = `${current} (not running)`;
      sel.appendChild(opt);
    }
    sel.value = current;
  };

  function showStatus(p) {
    const el = document.getElementById("status");
    if (!el) return;
    if (p.connected) {
      el.className = "status ok";
      el.textContent = `Connected to herdr ${p.version ?? ""} · ${p.agents.length} agent(s)`;
    } else {
      el.className = "status bad";
      el.textContent = `Not connected (${p.lastError ?? "no server"}). Endpoint: ${p.endpoint}`;
    }
  }

  // Called by Stream Deck.
  window.connectElgatoStreamDeckSocket = function (port, inUUID, registerEvent, info, actionInfo) {
    uuid = inUUID;
    try {
      const ai = JSON.parse(actionInfo);
      actionUUID = ai.action;
      settings = ai.payload?.settings ?? {};
    } catch {
      settings = {};
    }
    ws = new WebSocket("ws://127.0.0.1:" + port);
    ws.onopen = () => {
      send({ event: registerEvent, uuid });
      send({ event: "getGlobalSettings", context: uuid });
      send({ event: "sendToPlugin", action: actionUUID, context: uuid, payload: { type: "getOptions" } });
      fill();
      // Persist defaults so the plugin sees them.
      saveSettings();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.event === "didReceiveGlobalSettings") {
        globals = msg.payload?.settings ?? {};
        if (lastOptions?.globals) globals = { ...lastOptions.globals, ...globals };
        fill();
      } else if (msg.event === "didReceiveSettings") {
        settings = msg.payload?.settings ?? {};
        fill();
      } else if (msg.event === "sendToPropertyInspector" && msg.payload?.type === "options") {
        lastOptions = msg.payload;
        globals = { ...msg.payload.globals, ...globals };
        showStatus(msg.payload);
        if (typeof window.onOptions === "function") window.onOptions(msg.payload);
        fill();
      }
    };
  };

  document.addEventListener("DOMContentLoaded", wire);
})();
