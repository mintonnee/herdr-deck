// Bring the app that shows herdr to the foreground (optional).

import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const HERDR_UI_NOT_RUNNING = 3;

let busy = false;

function defaultHerdrUiPath() {
  if (process.platform !== "win32") return "herdr-gpui";
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Programs", "Herdr UI", "herdr-gpui.exe");
}

/** Start Herdr UI. Windows uses its launcher: herdr-gpui.exe is a console program. */
function launchHerdrUi(exe) {
  const target = process.platform === "win32" ? path.join(path.dirname(exe), "herdr-gpui-launcher.exe") : exe;
  return new Promise((resolve, reject) => {
    const child = spawn(target, [], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Focus Herdr UI, starting it if needed. Rejects when the app cannot be focused. */
export function focusHerdrUi(exePath) {
  if (busy) return Promise.resolve();
  busy = true;
  const exe = exePath || defaultHerdrUiPath();
  return new Promise((resolve, reject) => {
    execFile(exe, ["app", "focus", "--json"], { windowsHide: true, timeout: 5000 }, (err, stdout, stderr) => {
      if (!err) resolve();
      else if (err.code === HERDR_UI_NOT_RUNNING) launchHerdrUi(exe).then(resolve, reject);
      else reject(new Error(`herdr-gpui app focus failed: ${stdout.trim() || stderr.trim() || err.message}`));
    });
  }).finally(() => {
    busy = false;
  });
}

export function bringToFront(processName) {
  if (!processName || busy) return;
  const name = String(processName).replace(/\.exe$/i, "").replace(/[^A-Za-z0-9_.\- ]/g, "");
  if (!name) return;
  busy = true;
  const done = () => {
    busy = false;
  };
  if (process.platform === "win32") {
    const script =
      `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
      `if ($p) { $null = (New-Object -ComObject WScript.Shell).AppActivate($p.Id) }`;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 5000 },
      done,
    );
  } else if (process.platform === "darwin") {
    execFile("osascript", ["-e", `tell application "${name}" to activate`], { timeout: 5000 }, done);
  } else {
    done();
  }
}
