// End-to-end, herdr-core backend: real plugin process <-> mock Stream Deck + mock
// herdr-core, with fake herdr-app and hc programs. macOS/Linux (Unix socket).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { MockCore } from "./mock-core.mjs";
import { MockStreamDeck } from "./mock-streamdeck.mjs";

const PLUGIN = path.resolve(import.meta.dirname, "../com.herdrdeck.streamdeck.sdPlugin/bin/plugin.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-core-"));
const run = path.join(tmp, "run");
const sockPath = path.join(run, "herdr-core", "default.sock"); // $XDG_RUNTIME_DIR/herdr-core/<session>.sock
const bin = path.join(tmp, "bin");
const log = path.join(tmp, "calls.log");
const script = path.join(tmp, "script.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(bin);
const exe = (name) => path.join(bin, process.platform === "win32" ? `${name}.exe` : name);
for (const name of ["herdr-app", "herdr-core"]) fs.copyFileSync(process.execPath, exe(name));
const setScript = (s) => fs.writeFileSync(script, JSON.stringify(s));
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearCalls = () => fs.rmSync(log, { force: true });

const A = "com.herdrdeck.streamdeck";
const KEYS = {
  k1: { action: `${A}.agent`, settings: { mode: "slot", slot: 1 } },
  k2: { action: `${A}.agent`, settings: { mode: "slot", slot: 2 } },
  k3: { action: `${A}.agent`, settings: { mode: "slot", slot: 3 } },
  k4: { action: `${A}.agent`, settings: { mode: "slot", slot: 4 } },
  k5: { action: `${A}.agent`, settings: { mode: "slot", slot: 5 } },
  kat: { action: `${A}.attention`, settings: {} },
  kws: { action: `${A}.workspace`, settings: { mode: "slot", slot: 2 } },
  ksk: { action: `${A}.sendkeys`, settings: { keys: "esc ctrl+c", target: "focused" } },
  kpw: { action: `${A}.power`, settings: { confirmStop: true } },
};

const svgOf = (msg) => decodeURIComponent(msg.payload.image.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
const textsOf = (svg) => [...(svg ?? "").matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
function latestImage(sd, ctx) {
  const imgs = sd.received.filter((m) => m.event === "setImage" && m.context === ctx);
  return imgs.length ? svgOf(imgs.at(-1)) : null;
}
const texts = (sd, ctx) => textsOf(latestImage(sd, ctx));
async function waitFor(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = fn();
      if (v) return v;
    } catch {}
    await sleep(40);
  }
  throw new Error("timeout waiting for: " + label);
}
const press = (sd, ctx) => sd.send({ event: "keyDown", action: KEYS[ctx].action, context: ctx, payload: { settings: KEYS[ctx].settings } });
const appCall = (command) => calls().find((c) => c.exe === "herdr-app" && c.args[0] === "do" && c.args[1] === command);

const core = new MockCore(sockPath);
await core.listen();
const sd = new MockStreamDeck();
const port = await sd.listen();
setScript({});

const env = { ...process.env, XDG_RUNTIME_DIR: run, XDG_STATE_HOME: path.join(tmp, "state"), XDG_CONFIG_HOME: path.join(tmp, "cfg"), HOME: tmp };
for (const k of ["HC_SOCKET", "HC_SESSION", "HERDR_SOCKET_PATH"]) delete env[k];
env.NODE_OPTIONS = `--require "${path.join(import.meta.dirname, "fake-programs.cjs").replaceAll("\\", "/")}"`;
env.FAKE_LOG = log;
env.FAKE_SCRIPT = script;
const child = spawn(process.execPath, [PLUGIN, "-port", String(port), "-pluginUUID", "PLUGINCTX", "-registerEvent", "registerPlugin", "-info", "{}"], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});
const globals = { backend: "core", bringToFront: false, herdrAppPath: exe("herdr-app"), hcPath: exe("herdr-core") };

try {
  await waitFor(() => sd.received.find((m) => m.event === "registerPlugin"), "register");
  sd.send({ event: "didReceiveGlobalSettings", payload: { settings: globals } });
  for (const [ctx, k] of Object.entries(KEYS)) {
    sd.send({ event: "willAppear", action: k.action, context: ctx, device: "D", payload: { settings: k.settings, coordinates: { column: 0, row: 0 } } });
  }

  // 1. terminals that report status are agents, in the Herdr app's space/tab order
  await waitFor(() => texts(sd, "k1").includes("WORKING"), "k1 working");
  assert.deepEqual(texts(sd, "k1"), ["WORKING", "1", "claude", "api"]);
  await waitFor(() => texts(sd, "k2").includes("reviewer"), "k2 named terminal");
  assert.ok(texts(sd, "k2").includes("DONE"));
  await waitFor(() => texts(sd, "k3").includes("BLOCKED"), "k3 blocked (the plain shell t3 is skipped)");
  assert.ok(texts(sd, "k3").includes("web · agents"), "unnamed space is named after its first terminal's folder");
  await waitFor(() => texts(sd, "k4").includes("ERROR"), "k4 sub-agent error");
  assert.ok(texts(sd, "k4").includes("helper") && texts(sd, "k4").includes("web · agents"), "sub-agent placed with its parent");
  await waitFor(() => texts(sd, "k5").includes("slot 5"), "k5 empty");
  await waitFor(() => texts(sd, "kat")[0] === "2", "attention: blocked + error");
  assert.equal(texts(sd, "kat")[1], "blocked · 1 done");
  await waitFor(() => texts(sd, "kws").includes("web"), "workspace slot 2");
  await waitFor(() => texts(sd, "kpw").includes("ON · 4"), "power on");
  assert.ok(texts(sd, "kpw").includes("herdr-core"));
  console.log("✓ initial render");

  // 2. live events: status and the Herdr app's layout document
  await waitFor(() => core.subs.size > 0, "subscribed");
  core.setStatus("t1", "blocked");
  await waitFor(() => texts(sd, "k1").includes("BLOCKED"), "k1 -> blocked via event");
  await waitFor(() => texts(sd, "kat")[0] === "3", "attention 3");
  core.renameSpace("s2", "프론트");
  await waitFor(() => texts(sd, "kws").includes("프론트"), "space renamed via doc event");
  console.log("✓ live status + doc events");

  // 3. jumping goes through the Herdr app
  clearCalls();
  press(sd, "k2");
  const focus = await waitFor(() => appCall("agent.focus"), "herdr-app do agent.focus");
  assert.deepEqual(JSON.parse(focus.args[2]), { terminal: "t2" });
  await waitFor(() => latestImage(sd, "k2").includes('stroke="#FFFFFF"'), "k2 marked focused");
  clearCalls();
  press(sd, "kws");
  const sel = await waitFor(() => appCall("space.select"), "herdr-app do space.select");
  assert.deepEqual(JSON.parse(sel.args[2]), { id: "s2" });
  // attention cycles blocked/error first (t1, t4, t5), then done (t2); the space
  // jump left focus on its first agent, t4, so t5 is next
  clearCalls();
  press(sd, "kat");
  await waitFor(() => appCall("agent.focus"), "attention focus");
  assert.deepEqual(JSON.parse(appCall("agent.focus").args[2]), { terminal: "t5" });
  clearCalls();
  press(sd, "kat");
  await waitFor(() => appCall("agent.focus"), "attention focus 2");
  assert.deepEqual(JSON.parse(appCall("agent.focus").args[2]), { terminal: "t2" });
  console.log("✓ agent, space and attention jumps");

  // 4. send keys to the pane the Herdr window has focused
  setScript({
    replies: {
      "herdr-app status": { focused_pane: "p-t3", space: "s2" },
      "herdr-app ls": { spaces: [{ id: "s2", tabs: [{ id: "c2", terminals: [{ terminal: "t3", pane: "p-t3" }] }] }] },
    },
  });
  core.calls.length = 0;
  press(sd, "ksk");
  const keys = await waitFor(() => core.calls.find((c) => c.method === "terminal.keys"), "terminal.keys");
  assert.deepEqual(keys.params, { terminal: "t3", keys: ["esc", "ctrl+c"] });
  await waitFor(() => sd.received.find((m) => m.event === "showOk" && m.context === "ksk"), "showOk");
  console.log("✓ send keys to the focused terminal");

  // 5. raising the window, and opening the app when no window answers
  sd.send({ event: "didReceiveGlobalSettings", payload: { settings: { ...globals, bringToFront: true, frontend: "herdr-app" } } });
  await sleep(200);
  setScript({ replies: { "herdr-app do": "no Herdr window at /x/herdr-app.sock: refused" }, exits: { "herdr-app do": 1 } });
  clearCalls();
  press(sd, "k3");
  await waitFor(() => calls().some((c) => c.exe === "herdr-app" && c.args.length === 0), "app launched");
  setScript({});
  await waitFor(() => calls().filter((c) => c.args[0] === "do").length >= 2, "retried after launch");
  await waitFor(() => calls().filter((c) => c.exe === "herdr-app" && c.args.length === 0).length >= 2, "raised after the jump");
  sd.send({ event: "didReceiveGlobalSettings", payload: { settings: globals } });
  console.log("✓ opens and raises the Herdr app");

  // 6. session power: stop needs a second press, then start runs `hc server start`
  core.calls.length = 0;
  press(sd, "kpw");
  await waitFor(() => texts(sd, "kpw").includes("again: stop"), "confirm prompt");
  assert.ok(!core.calls.some((c) => c.method === "server.stop"), "first press does not stop");
  await sleep(3300);
  assert.ok(texts(sd, "kpw").some((s) => s.startsWith("ON")), "prompt times out");
  press(sd, "kpw");
  await waitFor(() => texts(sd, "kpw").includes("again: stop"), "confirm prompt 2");
  press(sd, "kpw");
  await waitFor(() => core.calls.some((c) => c.method === "server.stop"), "server.stop");
  await waitFor(() => texts(sd, "kpw").includes("OFF"), "power off", 8000);
  await waitFor(() => texts(sd, "k1").includes("offline") && texts(sd, "k1").includes("herdr-core"), "agents offline");
  await waitFor(() => sd.received.find((m) => m.event === "showOk" && m.context === "kpw"), "stop ok");
  console.log("✓ stop with confirmation");

  clearCalls();
  press(sd, "kpw");
  const start = await waitFor(() => calls().find((c) => c.exe === "herdr-core"), "hc server start");
  assert.deepEqual(start.args, ["server", "start", "--json"]);
  await waitFor(() => texts(sd, "kpw").includes("starting…"), "busy while starting");
  await core.listen(); // what the real `hc server start` would do
  await waitFor(() => texts(sd, "kpw").includes("ON · 4"), "power on again", 10000);
  await waitFor(() => texts(sd, "k1").includes("BLOCKED"), "agents back");
  console.log("✓ start");

  // 7. property inspector reports the backend and where it connects
  sd.send({ event: "propertyInspectorDidAppear", action: `${A}.power`, context: "kpw" });
  const opts = await waitFor(() => sd.received.findLast((m) => m.event === "sendToPropertyInspector" && m.context === "kpw"), "PI options");
  assert.equal(opts.payload.backend, "core");
  assert.equal(opts.payload.connected, true);
  assert.equal(opts.payload.endpoint, `${sockPath} (default)`);
  console.log("✓ property inspector");

  console.log("\nALL PASSED");
} finally {
  child.kill();
  await sd.close().catch(() => {});
  await core.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(0);
