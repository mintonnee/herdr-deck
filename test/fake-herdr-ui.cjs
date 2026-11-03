// Preloaded into a copy of the node binary so it can stand in for herdr-gpui on any OS.
// Records its arguments, then exits as the real CLI would.
const fs = require("node:fs");
const path = require("node:path");

// Node resolves its first argument to an absolute path before running a preload.
const [first, ...rest] = process.argv.slice(1);
const args = first === undefined ? [] : [path.basename(first), ...rest];
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify({ exe: path.basename(process.execPath), args }) + "\n");
if (args.length) process.stdout.write(process.env.FAKE_HERDR_OUTPUT ?? "");
process.exit(args.length ? Number(process.env.FAKE_HERDR_EXIT ?? 0) : 0);
