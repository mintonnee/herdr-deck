// Preloaded (NODE_OPTIONS=--require) into copies of the node binary named like
// herdr-app, herdr-core or herdr, so they stand in for those programs on any OS.
// Any other node process (the plugin itself) is left alone.
// Records its arguments to FAKE_LOG. FAKE_SCRIPT names a JSON file read on each
// run: { "replies": { "<exe> <first arg>": stdout }, "exits": { "<exe> <first arg>": code } }.
const fs = require("node:fs");
const path = require("node:path");

const exe = path.basename(process.execPath).replace(/\.exe$/i, "");
if (["herdr-app", "herdr-core", "herdr"].includes(exe)) {
  // Node resolves its first argument to an absolute path before running a preload.
  const [first, ...rest] = process.argv.slice(1);
  const args = first === undefined ? [] : [path.basename(first), ...rest];
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ exe, args }) + "\n");
  let script = {};
  try {
    script = JSON.parse(fs.readFileSync(process.env.FAKE_SCRIPT, "utf8"));
  } catch {}
  const key = `${exe} ${args[0] ?? ""}`.trim();
  const reply = script.replies?.[key];
  // writeSync: nothing may be lost to the exit below.
  if (reply !== undefined) fs.writeSync(1, typeof reply === "string" ? reply : JSON.stringify(reply));
  process.exit(Number(script.exits?.[key] ?? 0));
}
