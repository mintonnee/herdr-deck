# Herdr Deck

Stream Deck plugin for [herdr](https://herdr.dev): live agent status keys, jump to agents that need attention, switch workspaces, send keys, turn the session on and off.
Works with herdr's socket API or with [herdr-core](https://github.com/herdrdev/herdr-core) (`hc`) and the Herdr app.

Plain JavaScript, no dependencies. Runs on Stream Deck's bundled Node 24 (Stream Deck 7.1+).

## Layout

```
com.herdrdeck.streamdeck.sdPlugin/
  manifest.json
  bin/
    plugin.mjs      entry point: actions, rendering, key presses
    streamdeck.mjs  Stream Deck WebSocket connection (SDK protocol v2)
    herdr.mjs       herdr socket API client + live session cache
    core.mjs        herdr-core client: endpoint rules, JSON-RPC, layout mapping
    apps.mjs        finding and running herdr-app, hc and herdr
    render.mjs      144x144 SVG key images
    window.mjs      bring Herdr UI or the terminal to the front
  ui/               property inspectors (settings panels)
  imgs/             icons
test/
  mock-herdr.mjs       fake herdr API server
  mock-core.mjs        fake herdr-core
  mock-streamdeck.mjs  fake Stream Deck app
  run.mjs              end-to-end test (herdr)
  core-run.mjs         end-to-end test (herdr-core)
  core-paths-test.mjs  herdr-core endpoint rules and layout mapping
  fake-herdr-ui.cjs    fake herdr-gpui CLI
  fake-programs.cjs    fake herdr-app, hc and herdr
  window-test.mjs      Herdr UI focus test
```

## How it talks to herdr

Newline-delimited JSON over herdr's local socket:
Windows named pipe `\\.\pipe\<%APPDATA%\herdr\herdr.sock>`, or `~/.config/herdr/herdr.sock` on macOS/Linux.
It subscribes to lifecycle events plus `pane.agent_status_changed` for every agent pane, and treats each event as a
signal to re-read `session.snapshot`. A 5-second poll backs this up.

## How it talks to herdr-core

Pick "herdr-core (hc)" under "Connect to" in any key's herdr connection settings.

The plugin speaks JSON-RPC 2.0 in plain mode straight to the core's socket, finding it by the core's own rules
(`Paths::from_env` in herdr-core):

| | Default endpoint |
| --- | --- |
| macOS | `~/.local/state/herdr-core/<session>/<session>.sock` |
| Linux | `$XDG_RUNTIME_DIR/herdr-core/<session>.sock` (or `/run/user/<uid>/herdr-core/`) |
| Windows | `\\.\pipe\herdr-core-<USERNAME>-<session>.sock` |

The session is the Session setting, else `HC_SESSION`, else `default`. Overrides, highest first: the Socket path setting,
`HC_SOCKET`, `socket` in `config.toml` (`~/.config/herdr-core/` or `%APPDATA%\herdr-core\`).
Stream Deck doesn't load shell profiles, so on macOS/Linux the plugin also reads `<state>/core.lock`, where a running core
writes the socket it really listens on.

It subscribes to `events.subscribe` and treats each event as a signal to re-read `terminal.list` and the Herdr app's
`herdr-app` layout document (spaces and tabs); a heartbeat watchdog and a 5-second poll back this up.
Terminals that report a status (OSC 7501) are agents; plain shells are not. `error` counts as needing you, like `blocked`.

The core draws nothing, so jumps go through the Herdr app: `herdr-app do agent.focus` and `herdr-app do space.select`,
opening the app first if no window answers. Send Keys uses `terminal.keys`; "Focused pane" is the pane the Herdr window has focused.
Without the Herdr app there are no spaces: Workspace keys stay empty and jumps fail, while status keys and Send Keys still work.

## Session On/Off

Shows whether the session is running. Press to start it: `hc server start` for herdr-core, `herdr server` for herdr.
Programs started by it get your login shell's PATH. Stopping (`server.stop`) ends every program in the session, so by default
it takes a second press within 3 seconds; kept herdr-core terminals get a fresh shell on the next start.

The plugin looks for programs where their installers put them (`%LOCALAPPDATA%\Programs\herdr-core`, `~/.local/bin`,
Homebrew, …); set "hc path", "herdr path" or "Herdr app path" if yours live elsewhere.

## Raising the app

After a jump the plugin raises the frontend chosen in a key's settings (under "herdr connection"):

- **Herdr UI** (default): runs `herdr-gpui app focus --json`, and starts the app if it is not running.
  The default path is `%LOCALAPPDATA%\Programs\Herdr UI\herdr-gpui.exe` on Windows and `herdr-gpui` on `PATH` elsewhere.
- **Herdr app**: launches `herdr-app`, which brings a running window to the front or opens one. Always used with herdr-core
  unless you pick Terminal. The default path is `%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe` on Windows,
  `~/.local/bin/herdr-app` or `Herdr.app` elsewhere.
- **Terminal**: activates the process named in the Terminal setting.

## Develop

Install for live editing (Windows, from this folder):

```powershell
mklink /D "%APPDATA%\Elgato\StreamDeck\Plugins\com.herdrdeck.streamdeck.sdPlugin" "%CD%\com.herdrdeck.streamdeck.sdPlugin"
```

Restart Stream Deck after edits. Plugin logs: `%APPDATA%\Elgato\StreamDeck\Plugins\com.herdrdeck.streamdeck.sdPlugin\logs` and Stream Deck's own log folder.

Run the tests (Node 22+, macOS/Linux; uses `rsvg-convert` to save PNG renders):

```bash
node test/run.mjs ./renders
node test/core-run.mjs
```

Run the herdr-core path rules test (any OS):

```bash
node test/core-paths-test.mjs
```

Run the Herdr UI focus test (any OS):

```bash
node test/window-test.mjs
```

Package: zip the `com.herdrdeck.streamdeck.sdPlugin` folder and rename to `com.herdrdeck.streamdeck.streamDeckPlugin`,
or use Elgato's CLI: `streamdeck pack com.herdrdeck.streamdeck.sdPlugin`.
