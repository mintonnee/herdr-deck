// End-to-end test: real plugin process <-> mock Stream Deck + mock herdr.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { MockHerdr } from "./mock-herdr.mjs";
import { MockStreamDeck } from "./mock-streamdeck.mjs";

const PLUGIN = path.resolve(import.meta.dirname, "../com.herdrdeck.streamdeck.sdPlugin/bin/plugin.mjs");
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "hd-out-"));
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "hd-cfg-"));
const sockPath = path.join(cfg, "herdr", "herdr.sock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = "com.herdrdeck.streamdeck";
const KEYS = {
  k1: { action: `${A}.agent`, settings: { mode: "slot", slot: 1 } },
  k2: { action: `${A}.agent`, settings: { mode: "slot", slot: 2 } },
  k3: { action: `${A}.agent`, settings: { mode: "slot", slot: 3 } },
  k4: { action: `${A}.agent`, settings: { mode: "slot", slot: 4 } },
  kat: { action: `${A}.attention`, settings: {} },
  kws: { action: `${A}.workspace`, settings: { mode: "slot", slot: 2 } },
  ksk: { action: `${A}.sendkeys`, settings: { keys: "esc ctrl+c", target: "focused" } },
};

function svgOf(msg) {
  return decodeURIComponent(msg.payload.image.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
}
function textsOf(svg) {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}
function latestImage(sd, ctx) {
  const imgs = sd.received.filter((m) => m.event === "setImage" && m.context === ctx);
  return imgs.length ? svgOf(imgs.at(-1)) : null;
}
async function waitFor(fn, label, ms = 4000) {
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
function snap(sd, ctx, name) {
  const svg = latestImage(sd, ctx);
  const f = path.join(OUT, `${name}.svg`);
  fs.writeFileSync(f, svg);
  execFileSync("rsvg-convert", ["-w", "144", "-h", "144", f, "-o", f.replace(/\.svg$/, ".png")]);
}

const herdr = new MockHerdr(sockPath);
await herdr.listen();
const sd = new MockStreamDeck();
const port = await sd.listen();

const child = spawn(process.execPath, [PLUGIN, "-port", String(port), "-pluginUUID", "PLUGINCTX", "-registerEvent", "registerPlugin", "-info", "{}"], {
  env: { ...process.env, XDG_CONFIG_HOME: cfg, HERDR_SOCKET_PATH: "" },
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  await waitFor(() => sd.received.find((m) => m.event === "registerPlugin" && m.uuid === "PLUGINCTX"), "register");
  sd.send({ event: "didReceiveGlobalSettings", payload: { settings: { bringToFront: false } } });
  for (const [ctx, k] of Object.entries(KEYS)) {
    sd.send({ event: "willAppear", action: k.action, context: ctx, device: "D", payload: { settings: k.settings, coordinates: { column: 0, row: 0 } } });
  }

  // 1. initial render from snapshot
  await waitFor(() => textsOf(latestImage(sd, "k1")).includes("WORKING"), "k1 working");
  assert.deepEqual(textsOf(latestImage(sd, "k1")).slice(0, 3), ["WORKING", "1", "claude"]);
  assert.ok(latestImage(sd, "k1").includes('stroke="#FFFFFF"'), "focused agent has white border");
  await waitFor(() => textsOf(latestImage(sd, "k2")).includes("DONE"), "k2 done");
  await waitFor(() => textsOf(latestImage(sd, "k3")).includes("BLOCKED"), "k3 blocked");
  assert.ok(textsOf(latestImage(sd, "k3")).includes("웹 프론트"), "korean workspace label rendered");
  await waitFor(() => textsOf(latestImage(sd, "k4")).includes("slot 4"), "k4 empty slot");
  await waitFor(() => textsOf(latestImage(sd, "kat"))[0] === "1", "attention count 1 blocked");
  await waitFor(() => textsOf(latestImage(sd, "kws")).includes("웹 프론트"), "workspace slot 2");
  assert.ok(!sd.received.some((m) => m.event === "setImage" && m.context === "ksk"), "send keys keeps static icon");
  for (const k of ["k1", "k2", "k3", "k4", "kat", "kws"]) snap(sd, k, `1-${k}`);
  console.log("✓ initial render");

  // 2. live status event -> re-render
  await waitFor(() => herdr.subs.size > 0 && [...herdr.subs].some((s) => s.panes.size === 3), "subscribed to 3 panes");
  herdr.setStatus("w1:p1", "blocked");
  await waitFor(() => textsOf(latestImage(sd, "k1")).includes("BLOCKED"), "k1 -> blocked via event");
  await waitFor(() => textsOf(latestImage(sd, "kat"))[0] === "2", "attention count 2");
  snap(sd, "kat", "2-kat-two-blocked");
  console.log("✓ live status events");

  // 3. attention press cycles blocked agents: focused w1:p1 is blocked -> next is w2:p1
  herdr.calls.length = 0;
  sd.send({ event: "keyDown", action: `${A}.attention`, context: "kat", payload: { settings: {} } });
  await waitFor(() => herdr.calls.find((c) => c.method === "agent.focus"), "agent.focus call");
  assert.equal(herdr.calls.find((c) => c.method === "agent.focus").params.target, "w2:p1");
  await waitFor(() => latestImage(sd, "k3").includes('stroke="#FFFFFF"'), "k3 now focused");
  herdr.calls.length = 0;
  sd.send({ event: "keyDown", action: `${A}.attention`, context: "kat", payload: { settings: {} } });
  await waitFor(() => herdr.calls.find((c) => c.method === "agent.focus"), "agent.focus call 2");
  assert.equal(herdr.calls.find((c) => c.method === "agent.focus").params.target, "w1:p2"); // blocked first, then done
  console.log("✓ attention cycling");

  // 4. agent key press + workspace key + send keys
  herdr.calls.length = 0;
  sd.send({ event: "keyDown", action: `${A}.agent`, context: "k2", payload: { settings: KEYS.k2.settings } });
  await waitFor(() => herdr.calls.find((c) => c.method === "agent.focus" && c.params.target === "w1:p2"), "focus slot 2");
  sd.send({ event: "keyDown", action: `${A}.workspace`, context: "kws", payload: { settings: KEYS.kws.settings } });
  await waitFor(() => herdr.calls.find((c) => c.method === "workspace.focus" && c.params.workspace_id === "w2"), "workspace focus");
  await sleep(300);
  sd.send({ event: "keyDown", action: `${A}.sendkeys`, context: "ksk", payload: { settings: KEYS.ksk.settings } });
  const sk = await waitFor(() => herdr.calls.find((c) => c.method === "pane.send_keys"), "send keys");
  assert.deepEqual(sk.params, { pane_id: herdr.state.focused_pane_id, keys: ["esc", "ctrl+c"] });
  await waitFor(() => sd.received.find((m) => m.event === "showOk" && m.context === "ksk"), "showOk");
  console.log("✓ key presses");

  // 5. new agent appears -> fills slot 4 and gets a status subscription
  herdr.addAgent({ terminal_id: "t4", agent: "opencode", name: "reviewer", agent_status: "idle", workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p2", focused: false });
  await waitFor(() => textsOf(latestImage(sd, "k4")).includes("reviewer"), "slot 4 filled");
  await waitFor(() => [...herdr.subs].some((s) => s.panes.has("w2:p2")), "resubscribed incl. new pane");
  herdr.setStatus("w2:p2", "working");
  await waitFor(() => textsOf(latestImage(sd, "k4")).includes("WORKING"), "slot 4 live");
  snap(sd, "k4", "3-k4-new-agent");
  console.log("✓ new agent + resubscribe");

  // 6. settings change from the property inspector
  sd.send({ event: "didReceiveSettings", action: `${A}.agent`, context: "k1", payload: { settings: { mode: "pane", paneId: "w2:p2" } } });
  await waitFor(() => textsOf(latestImage(sd, "k1")).includes("reviewer"), "k1 pinned to pane");
  sd.send({ event: "propertyInspectorDidAppear", action: `${A}.agent`, context: "k1" });
  const opts = await waitFor(() => sd.received.find((m) => m.event === "sendToPropertyInspector" && m.context === "k1"), "PI options");
  assert.equal(opts.payload.connected, true);
  assert.equal(opts.payload.agents.length, 4);
  console.log("✓ property inspector + pinned pane");

  // 7. herdr goes away -> offline; comes back -> recovers
  await herdr.close();
  await waitFor(() => textsOf(latestImage(sd, "k2")).includes("offline"), "offline", 6000);
  snap(sd, "k2", "4-offline");
  sd.send({ event: "keyDown", action: `${A}.agent`, context: "k2", payload: { settings: KEYS.k2.settings } });
  await waitFor(() => sd.received.find((m) => m.event === "showAlert" && m.context === "k2"), "alert while offline");
  await herdr.listen();
  await waitFor(() => textsOf(latestImage(sd, "k2")).includes("DONE"), "recovered", 20000);
  console.log("✓ offline + reconnect");

  // 8. stale pane in subscription is rejected -> plugin recovers without going offline
  herdr.state.agents = herdr.state.agents.filter((a) => a.pane_id !== "w1:p2");
  for (const s of herdr.subs) s.sock.destroy(); // force resubscribe with the stale pane set
  await waitFor(() => [...herdr.subs].some((s) => s.panes.size === 3 && !s.panes.has("w1:p2")), "resubscribed after rejection", 8000);
  assert.ok(!textsOf(latestImage(sd, "k2")).includes("offline"), "never showed offline");
  console.log("✓ rejected subscription recovery");

  console.log(`\nALL PASSED  (renders in ${OUT})`);
} finally {
  child.kill();
  await sd.close().catch(() => {});
  try {
    await herdr.close();
  } catch {}
}
process.exit(0);
