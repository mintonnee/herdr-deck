// Shared property-inspector glue (no dependencies).
// Each page declares inputs with data-setting="name" (per-key settings) or
// data-global="name" (plugin-wide settings), and may define window.onOptions(payload).

(function () {
  // Plugin-wide settings, shared by every action's page (placed where the page has
  // <div id="connection"></div>). data-global-show="name=value" shows a row only then.
  const CONNECTION = `
<details>
  <summary>herdr connection (all keys)</summary>
  <div class="row">
    <label for="g-backend">Connect to</label>
    <select id="g-backend" data-global="backend">
      <option value="herdr">herdr</option>
      <option value="core">herdr-core (hc)</option>
    </select>
    <div class="hint">herdr: herdr's socket API. herdr-core: the hc core, with spaces and tabs from the Herdr app.</div>
  </div>
  <div class="row">
    <label for="g-front">Raise window</label>
    <input id="g-front" type="checkbox" data-global="bringToFront" />
    <div class="hint">Bring the app showing herdr to the front after jumping.</div>
  </div>
  <div class="row">
    <label for="g-frontend">Frontend</label>
    <select id="g-frontend" data-global="frontend">
      <option value="herdr-ui">Herdr UI (herdr-gpui)</option>
      <option value="herdr-app">Herdr app</option>
      <option value="terminal">Terminal</option>
    </select>
    <div class="hint">The app to raise. herdr-core is shown by the Herdr app unless you pick Terminal. Apps start if not running.</div>
  </div>
  <div class="row" data-global-show="backend=herdr">
    <label for="g-ui-path">Herdr UI path</label>
    <input id="g-ui-path" type="text" data-global="herdrUiPath" placeholder="auto" />
    <div class="hint">Herdr UI only. Path to herdr-gpui. Empty = default install location.</div>
  </div>
  <div class="row">
    <label for="g-app-path">Herdr app path</label>
    <input id="g-app-path" type="text" data-global="herdrAppPath" placeholder="auto" />
    <div class="hint">Path to herdr-app. herdr-core uses it to focus agents and spaces. Empty = default install location.</div>
  </div>
  <div class="row">
    <label for="g-proc">Terminal</label>
    <input id="g-proc" type="text" data-global="terminalProcess" placeholder="WindowsTerminal" />
    <div class="hint">Terminal only. Process name, e.g. WindowsTerminal, wezterm-gui, alacritty.</div>
  </div>
  <div class="row">
    <label for="g-session">Session</label>
    <input id="g-session" type="text" data-global="session" placeholder="(default)" />
    <div class="hint" data-global-show="backend=herdr">Named herdr session (herdr --session NAME). Empty = default.</div>
    <div class="hint" data-global-show="backend=core">herdr-core session (HC_SESSION). Empty = HC_SESSION, else "default".</div>
  </div>
  <div class="row">
    <label for="g-socket">Socket path</label>
    <input id="g-socket" type="text" data-global="socketPath" placeholder="auto" />
    <div class="hint" data-global-show="backend=herdr">Override only if auto-detect fails. Empty = %APPDATA%\\herdr\\herdr.sock.</div>
    <div class="hint" data-global-show="backend=core">Override only if auto-detect fails. Empty = HC_SOCKET, config.toml socket, else the core's default.</div>
  </div>
  <div class="row" data-global-show="backend=core">
    <label for="g-hc">hc path</label>
    <input id="g-hc" type="text" data-global="hcPath" placeholder="auto" />
    <div class="hint">Session On/Off key only: runs "hc server start". Empty = default install location.</div>
  </div>
  <div class="row" data-global-show="backend=herdr">
    <label for="g-herdr">herdr path</label>
    <input id="g-herdr" type="text" data-global="herdrPath" placeholder="auto" />
    <div class="hint">Session On/Off key only: runs "herdr server". Empty = default install location.</div>
  </div>
  <div class="row"><label></label><button id="reconnect" type="button">Reconnect</button></div>
</details>`;

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
    document.querySelectorAll("[data-global-show]").forEach((el) => {
      const [name, value] = el.dataset.globalShow.split("=");
      el.style.display = String(globals[name] ?? "") === value ? "" : "none";
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
    const slot = document.getElementById("connection");
    if (slot) slot.outerHTML = CONNECTION;
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
        syncVisibility();
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
      el.textContent = `Connected to ${p.backendName ?? "herdr"} ${p.version ?? ""} · ${p.agents.length} agent(s)`;
    } else {
      el.className = "status bad";
      el.textContent = `${p.backendName ?? "herdr"} not connected (${p.lastError ?? "no server"}). Endpoint: ${p.endpoint}`;
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
