// Minimal, dependency-free Stream Deck plugin connection (SDK protocol v2).
// Uses the global WebSocket client that ships with Node 22+ (the plugin runs on Node 24).

import { EventEmitter } from "node:events";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("-") && i + 1 < argv.length) {
      out[arg.replace(/^-+/, "")] = argv[i + 1];
      i++;
    }
  }
  return out;
}

export class StreamDeck extends EventEmitter {
  constructor(argv = process.argv.slice(2)) {
    super();
    const args = parseArgs(argv);
    this.port = args.port;
    this.pluginUUID = args.pluginUUID;
    this.registerEvent = args.registerEvent;
    try {
      this.info = JSON.parse(args.info ?? "{}");
    } catch {
      this.info = {};
    }
    this.ws = null;
    this.queue = [];
    this.globalSettings = {};
  }

  connect() {
    if (!this.port || !this.pluginUUID) {
      throw new Error("Missing -port / -pluginUUID launch arguments (is Stream Deck starting this plugin?)");
    }
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ event: this.registerEvent, uuid: this.pluginUUID }));
      for (const msg of this.queue.splice(0)) ws.send(msg);
      this.send({ event: "getGlobalSettings", context: this.pluginUUID });
      this.emit("connected");
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      } catch {
        return;
      }
      if (msg.event === "didReceiveGlobalSettings") {
        this.globalSettings = msg.payload?.settings ?? {};
      }
      this.emit("message", msg);
      if (msg.event) this.emit(msg.event, msg);
    });
    ws.addEventListener("close", () => {
      // Stream Deck closes the socket when it quits or unloads the plugin.
      process.exit(0);
    });
    ws.addEventListener("error", () => {});
  }

  send(obj) {
    const msg = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === 1) this.ws.send(msg);
    else this.queue.push(msg);
  }

  setTitle(context, title) {
    this.send({ event: "setTitle", context, payload: { title, target: 0 } });
  }

  setImage(context, image) {
    this.send({ event: "setImage", context, payload: { image, target: 0 } });
  }

  setSettings(context, settings) {
    this.send({ event: "setSettings", context, payload: settings });
  }

  setGlobalSettings(settings) {
    this.globalSettings = settings;
    this.send({ event: "setGlobalSettings", context: this.pluginUUID, payload: settings });
  }

  showAlert(context) {
    this.send({ event: "showAlert", context });
  }

  showOk(context) {
    this.send({ event: "showOk", context });
  }

  sendToPropertyInspector(action, context, payload) {
    this.send({ event: "sendToPropertyInspector", action, context, payload });
  }

  log(message) {
    this.send({ event: "logMessage", payload: { message: String(message) } });
  }
}
