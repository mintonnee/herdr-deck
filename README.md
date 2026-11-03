# Herdr Deck

Stream Deck plugin for [herdr](https://herdr.dev): live agent status keys, jump to agents that need attention, switch workspaces, send keys.

Plain JavaScript, no dependencies. Runs on Stream Deck's bundled Node 24 (Stream Deck 7.1+).

## Layout

```
com.herdrdeck.streamdeck.sdPlugin/
  manifest.json
  bin/
    plugin.mjs      entry point: actions, rendering, key presses
    streamdeck.mjs  Stream Deck WebSocket connection (SDK protocol v2)
    herdr.mjs       herdr socket API client + live session cache
    render.mjs      144x144 SVG key images
    window.mjs      bring Herdr UI or the terminal to the front
  ui/               property inspectors (settings panels)
  imgs/             icons
test/
  mock-herdr.mjs       fake herdr API server
  mock-streamdeck.mjs  fake Stream Deck app
  run.mjs              end-to-end test
  fake-herdr-ui.cjs    fake herdr-gpui CLI
  window-test.mjs      Herdr UI focus test
```

## How it talks to herdr

Newline-delimited JSON over herdr's local socket:
Windows named pipe `\\.\pipe\<%APPDATA%\herdr\herdr.sock>`, or `~/.config/herdr/herdr.sock` on macOS/Linux.
It subscribes to lifecycle events plus `pane.agent_status_changed` for every agent pane, and treats each event as a
signal to re-read `session.snapshot`. A 5-second poll backs this up.

## Raising the app

After a jump the plugin raises the frontend chosen in a key's settings (under "herdr connection"):

- **Herdr UI** (default): runs `herdr-gpui app focus --json`, and starts the app if it is not running.
  The default path is `%LOCALAPPDATA%\Programs\Herdr UI\herdr-gpui.exe` on Windows and `herdr-gpui` on `PATH` elsewhere.
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
```

Run the Herdr UI focus test (any OS):

```bash
node test/window-test.mjs
```

Package: zip the `com.herdrdeck.streamdeck.sdPlugin` folder and rename to `com.herdrdeck.streamdeck.streamDeckPlugin`,
or use Elgato's CLI: `streamdeck pack com.herdrdeck.streamdeck.sdPlugin`.
