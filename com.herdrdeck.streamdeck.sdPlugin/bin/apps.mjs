// Programs the plugin runs: the Herdr desktop app (`herdr-app`), herdr-core
// (`hc`) and herdr. Stream Deck starts plugins without the person's shell PATH,
// so each is looked for where its installer puts it.

import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The configured path, else the first candidate that exists, else the bare name (PATH lookup). */
export function findProgram(configured, candidates, bare) {
  if (configured) return configured.replace(/^~(?=[\\/])/, os.homedir());
  return candidates.find(isFile) ?? bare;
}

/** Where herdr-core gets installed (its installers, Homebrew, mise, Nix, cargo). */
export function hcCandidates(home = os.homedir()) {
  if (IS_WIN) {
    const dir = path.join(localAppData(), "Programs", "herdr-core");
    return [path.join(dir, "herdr-core.exe"), path.join(dir, "hc.exe"), path.join(home, ".cargo", "bin", "herdr-core.exe")];
  }
  const dirs = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".nix-profile", "bin"),
    "/run/current-system/sw/bin",
    path.join(home, ".cargo", "bin"),
  ];
  if (IS_MAC) dirs.push(path.join(home, ".local", "share", "herdr-core", "current", "Contents", "MacOS"));
  // `herdr-core` first: some window managers ship an unrelated `hc`.
  return [...dirs.map((d) => path.join(d, "herdr-core")), ...dirs.map((d) => path.join(d, "hc"))];
}

export function herdrAppCandidates(home = os.homedir()) {
  if (IS_WIN) return [path.join(localAppData(), "Programs", "herdr-app", "herdr-app.exe")];
  const out = [path.join(home, ".local", "bin", "herdr-app")];
  if (IS_MAC) {
    out.push(path.join(home, "Applications", "Herdr.app", "Contents", "MacOS", "Herdr"));
    out.push("/Applications/Herdr.app/Contents/MacOS/Herdr");
  }
  return out;
}

export function herdrCandidates(home = os.homedir()) {
  if (IS_WIN) return [path.join(localAppData(), "Programs", "Herdr", "bin", "herdr.exe")];
  return [path.join(home, ".local", "bin", "herdr"), "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"];
}

export const hcPath = (configured) => findProgram(configured, hcCandidates(), IS_WIN ? "herdr-core.exe" : "herdr-core");
export const herdrAppPath = (configured) => findProgram(configured, herdrAppCandidates(), "herdr-app");
export const herdrPath = (configured) => findProgram(configured, herdrCandidates(), "herdr");

function run(exe, args, { timeout = 8000, env } = {}) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout, env, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    );
  });
}

function detached(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true, ...opts });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** The .app bundle an executable lives in (following the ~/.local/bin link), or null. */
function bundleOf(exe) {
  if (!IS_MAC) return null;
  let real = exe;
  try {
    real = fs.realpathSync(exe);
  } catch {}
  const m = real.match(/^(.*?\.app)\/Contents\/MacOS\//);
  return m ? m[1] : null;
}

/**
 * Open the Herdr window, or bring the running one to the front: a second
 * launch raises the first and quits. On macOS go through LaunchServices so the
 * app gets the environment its bundle asks for.
 */
export function raiseHerdrApp(configured) {
  const exe = herdrAppPath(configured);
  const bundle = bundleOf(exe);
  if (bundle) return detached("open", [bundle]);
  return detached(exe, []);
}

const NOT_RUNNING = /no Herdr window/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `herdr-app do <command> <json>`: run one app command in the open window.
 * Opens the app first when no window answers, then waits for it.
 */
export async function herdrAppDo(configured, command, args = {}, { launchWaitMs = 10000 } = {}) {
  const exe = herdrAppPath(configured);
  const call = async () => {
    const { err, stdout, stderr } = await run(exe, ["do", command, JSON.stringify(args)]);
    let reply = null;
    try {
      reply = JSON.parse(stdout);
    } catch {}
    if (!err && !reply?.error) return { ok: true, reply };
    const message = (typeof reply?.error === "string" ? reply.error : reply?.error?.message) || stderr.trim() || stdout.trim() || err?.message;
    return { ok: false, message, notRunning: err?.code !== "ENOENT" && NOT_RUNNING.test(message), missing: err?.code === "ENOENT" };
  };
  let res = await call();
  if (res.missing) throw Object.assign(new Error(`Herdr app not found at ${exe}`), { code: "ENOENT" });
  if (res.notRunning && launchWaitMs > 0) {
    await raiseHerdrApp(configured);
    const end = Date.now() + launchWaitMs;
    while (res.notRunning && Date.now() < end) {
      await sleep(400);
      res = await call();
    }
  }
  if (!res.ok) throw new Error(`herdr-app do ${command}: ${res.message}`);
  return res.reply;
}

/** `herdr-app status` / `herdr-app ls` from the open window, or null when none answers. */
export async function herdrAppQuery(configured, verb) {
  const { err, stdout } = await run(herdrAppPath(configured), [verb], { timeout: 5000 });
  if (err) return null;
  try {
    const reply = JSON.parse(stdout);
    return reply?.error ? null : reply;
  } catch {
    return null;
  }
}

/** The terminal in the Herdr window's focused pane, or null. */
export async function herdrAppFocusedTerminal(configured) {
  const [status, world] = await Promise.all([herdrAppQuery(configured, "status"), herdrAppQuery(configured, "ls")]);
  const pane = status?.focused_pane;
  if (!pane || !world) return null;
  for (const space of world.spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      for (const t of tab.terminals ?? []) if (t.pane === pane && t.terminal) return t.terminal;
    }
  }
  return null;
}

/** The PATH a login shell sets up (macOS/Linux), so programs started from here find the person's tools. */
let loginPathCache;
export async function loginShellPath() {
  if (IS_WIN) return null;
  if (loginPathCache !== undefined) return loginPathCache;
  const shell = process.env.SHELL || (IS_MAC ? "/bin/zsh" : "/bin/sh");
  const { err, stdout } = await run(shell, ["-lc", 'printf %s "$PATH"'], { timeout: 3000 });
  loginPathCache = err || !stdout.trim() ? null : stdout.trim();
  return loginPathCache;
}

/** process.env with the login shell's PATH (and the usual bin dirs) in front of the current one. */
export async function programEnv(extra = {}) {
  const env = { ...process.env };
  if (!IS_WIN) {
    const dirs = [];
    const login = await loginShellPath();
    if (login) dirs.push(...login.split(":"));
    dirs.push(path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
    dirs.push(...String(env.PATH ?? "").split(":"));
    env.PATH = [...new Set(dirs.filter(Boolean))].join(":");
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === "") delete env[k];
    else env[k] = String(v);
  }
  return env;
}

/** `hc server start`: start the herdr-core session's core (programs started there get this env). */
export async function startCore({ hcPath: configured, session, socketPath } = {}) {
  const exe = hcPath(configured);
  const env = await programEnv({ HC_SESSION: session || undefined, HC_SOCKET: socketPath || undefined });
  const { err, stdout, stderr } = await run(exe, ["server", "start", "--json"], { timeout: 20000, env });
  if (err) {
    if (err.code === "ENOENT") throw Object.assign(new Error(`herdr-core not found at ${exe}`), { code: "ENOENT" });
    throw new Error(`hc server start: ${stderr.trim() || stdout.trim() || err.message}`);
  }
}

/** `herdr server`: start a headless herdr server in the background. */
export async function startHerdrServer({ herdrPath: configured, session, socketPath } = {}) {
  const exe = herdrPath(configured);
  const env = await programEnv({ HERDR_SESSION: session || undefined, HERDR_SOCKET_PATH: socketPath || undefined });
  await detached(exe, ["server"], { env, cwd: os.homedir() }).catch((err) => {
    if (err.code === "ENOENT") throw Object.assign(new Error(`herdr not found at ${exe}`), { code: "ENOENT" });
    throw err;
  });
}
