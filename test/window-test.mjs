// Tests focusHerdrUi against a fake herdr-gpui. Runs on Windows, macOS and Linux.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { focusHerdrUi } from "../com.herdrdeck.streamdeck.sdPlugin/bin/window.mjs";

const IS_WIN = process.platform === "win32";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-ui-"));
const exeName = IS_WIN ? "herdr-gpui.exe" : "herdr-gpui";
const launcherName = IS_WIN ? "herdr-gpui-launcher.exe" : exeName;
const exe = path.join(dir, exeName);
const log = path.join(dir, "calls.log");
const preload = path.join(import.meta.dirname, "fake-herdr-ui.cjs").replaceAll("\\", "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function calls() {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}
function reset(exit, output = "") {
  fs.rmSync(log, { force: true });
  process.env.FAKE_HERDR_EXIT = String(exit);
  process.env.FAKE_HERDR_OUTPUT = output;
}
async function waitForCalls(count) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (calls().length >= count) return calls();
    await sleep(40);
  }
  throw new Error(`timeout waiting for ${count} calls, got ${calls().length}`);
}

const FOCUS = { exe: exeName, args: ["app", "focus", "--json"] };

fs.copyFileSync(process.execPath, exe);
fs.copyFileSync(process.execPath, path.join(dir, launcherName));
process.env.FAKE_HERDR_LOG = log;
process.env.NODE_OPTIONS = `--require "${preload}"`;

try {
  reset(0);
  await focusHerdrUi(exe);
  assert.deepEqual(calls(), [FOCUS]);
  console.log("✓ focuses the running app");

  reset(3);
  await focusHerdrUi(exe);
  assert.deepEqual(await waitForCalls(2), [FOCUS, { exe: launcherName, args: [] }]);
  console.log("✓ starts the app when it is not running");

  reset(6, '{"error":{"code":"busy","message":"A dialog is open"}}');
  await assert.rejects(focusHerdrUi(exe), /A dialog is open/);
  assert.deepEqual(calls(), [FOCUS]);
  console.log("✓ reports a busy app and does not start another");

  await assert.rejects(focusHerdrUi(path.join(dir, "missing", exeName)), /ENOENT/);
  console.log("✓ reports a missing executable");

  reset(0);
  await Promise.all([focusHerdrUi(exe), focusHerdrUi(exe)]);
  assert.deepEqual(calls(), [FOCUS]);
  console.log("✓ ignores a press during a focus");

  console.log("\nALL PASSED");
} finally {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
