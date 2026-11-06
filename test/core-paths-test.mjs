// herdr-core endpoint rules (paths.rs Paths::from_env) and layout mapping. Any OS.
import assert from "node:assert/strict";
import { coreEndpoint, resolveCoreEndpoint, configSocket, buildSnapshot, terminalsInTree } from "../com.herdrdeck.streamdeck.sdPlugin/bin/core.mjs";

const none = () => {
  throw new Error("ENOENT");
};
const mac = (env = {}, extra = {}) => ({ platform: "darwin", home: "/Users/u", env: { HOME: "/Users/u", ...env }, readFile: none, isDir: () => false, uid: 501, ...extra });
const linux = (env = {}, extra = {}) => ({ platform: "linux", home: "/home/u", env: { HOME: "/home/u", ...env }, readFile: none, isDir: () => false, uid: 1000, ...extra });
const win = (env = {}, extra = {}) => ({
  platform: "win32",
  home: "C:\\Users\\Jo",
  env: { USERPROFILE: "C:\\Users\\Jo", LOCALAPPDATA: "C:\\Users\\Jo\\AppData\\Local", APPDATA: "C:\\Users\\Jo\\AppData\\Roaming", USERNAME: "Jo Kim", ...env },
  readFile: none,
  ...extra,
});

// macOS has no XDG_RUNTIME_DIR or /run/user: the socket sits in the session's state dir.
assert.equal(coreEndpoint({}, mac()).endpoint, "/Users/u/.local/state/herdr-core/default/default.sock");
assert.equal(coreEndpoint({ session: "work" }, mac()).endpoint, "/Users/u/.local/state/herdr-core/work/work.sock");
assert.equal(coreEndpoint({}, mac({ HC_SESSION: " ci " })).endpoint, "/Users/u/.local/state/herdr-core/ci/ci.sock");
assert.equal(coreEndpoint({}, mac({ XDG_STATE_HOME: "/s" })).endpoint, "/s/herdr-core/default/default.sock");
console.log("✓ macOS default");

assert.equal(coreEndpoint({}, linux({ XDG_RUNTIME_DIR: "/run/user/1000" })).endpoint, "/run/user/1000/herdr-core/default.sock");
assert.equal(coreEndpoint({}, linux({}, { isDir: (d) => d === "/run/user/1000" })).endpoint, "/run/user/1000/herdr-core/default.sock");
assert.equal(coreEndpoint({}, linux()).endpoint, "/home/u/.local/state/herdr-core/default/default.sock");
console.log("✓ Linux runtime dir and fallback");

assert.equal(coreEndpoint({}, win()).endpoint, "\\\\.\\pipe\\herdr-core-JoKim-default.sock");
assert.equal(coreEndpoint({ session: "b" }, win()).endpoint, "\\\\.\\pipe\\herdr-core-JoKim-b.sock");
assert.equal(coreEndpoint({}, win()).state, "C:\\Users\\Jo\\AppData\\Local\\herdr-core\\default");
assert.equal(coreEndpoint({}, win()).config, "C:\\Users\\Jo\\AppData\\Roaming\\herdr-core\\config.toml");
console.log("✓ Windows pipe name");

// Overrides: plugin setting > HC_SOCKET > config.toml socket > default.
const cfg = (text) => ({ readFile: (f) => (f.endsWith("config.toml") ? text : none()) });
assert.equal(coreEndpoint({}, mac({}, cfg('shell = ["nu"]\nsocket = "/tmp/hc.sock"\n'))).endpoint, "/tmp/hc.sock");
assert.equal(coreEndpoint({}, mac({}, cfg('socket = "/tmp/hc.sock"'))).source, "config");
assert.equal(coreEndpoint({}, mac({ HC_SOCKET: "/e.sock" }, cfg('socket = "/tmp/hc.sock"'))).endpoint, "/e.sock");
assert.equal(coreEndpoint({ socketPath: "/p.sock" }, mac({ HC_SOCKET: "/e.sock" })).endpoint, "/p.sock");
assert.equal(configSocket("socket = 'C:\\x\\y'"), "C:\\x\\y");
assert.equal(configSocket('[machines.box]\nsocket = "/no"'), null);
assert.equal(configSocket('# socket = "/no"'), null);
assert.throws(() => coreEndpoint({ session: "a/b" }, mac()), /can't be a folder name/);
console.log("✓ overrides and config.toml");

// core.lock: the core says where it really listens when this env points elsewhere.
const lockCtx = mac({}, {
  readFile: (f) => (f.endsWith("core.lock") ? "/run/elsewhere.sock" : none()),
  exists: (f) => f === "/run/elsewhere.sock",
});
assert.deepEqual(
  (({ endpoint, source }) => ({ endpoint, source }))(resolveCoreEndpoint({}, lockCtx)),
  { endpoint: "/run/elsewhere.sock", source: "core.lock" },
);
assert.equal(resolveCoreEndpoint({ socketPath: "/p.sock" }, lockCtx).endpoint, "/p.sock");
assert.equal(resolveCoreEndpoint({}, { ...lockCtx, exists: () => true }).source, "default", "computed socket exists: keep it");
console.log("✓ core.lock hint");

// Layout document -> workspaces, tabs and ordered agents.
const t = (address, state, extra = {}) => ({ address, state: "live", reported: !!state, status: state ? { state, app: "claude" } : null, argv: ["claude"], cwd: "/w/x", ...extra });
const root = (...ts) => ({ type: "column", children: [{ type: "block", content: { terminal: ts[0] } }, { type: "stack", children: ts.slice(1).map((x) => ({ type: "block", content: { terminal: x } })) }] });
assert.deepEqual(terminalsInTree(root("a", "b", "c")), ["a", "b", "c"]);
const snap = buildSnapshot({
  terminals: [t("t9", "idle"), t("t1", "done"), t("t2", "blocked"), t("t3", null), t("t4", "error", { parent: "t1" }), t("t5", "working", { state: "finished" })],
  doc: { spaces: [{ id: "s1", name: "", folder: "/w/api", tabs: [{ id: "c1", root: root("t1", "t3") }] }, { id: "s2", name: "web", tabs: [{ id: "c2", root: root("t2") }] }] },
  focused: "t2",
});
assert.deepEqual(snap.agents.map((a) => a.pane_id), ["t1", "t4", "t2", "t9"], "space order, sub-agent with its parent, unplaced last; no shells or finished");
assert.deepEqual(snap.workspaces.map((w) => [w.label, w.agent_status, w.focused]), [["x", "error", false], ["web", "blocked", true]]);
assert.equal(snap.agents.find((a) => a.pane_id === "t4").workspace_id, "s1");
assert.equal(snap.focused_pane_id, "t2");
assert.equal(buildSnapshot({ terminals: [t("t1", "done")] }).workspaces.length, 0, "no Herdr app document: no spaces");
console.log("✓ layout mapping");

console.log("\nALL PASSED");
