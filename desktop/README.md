# ClaudeOS Desktop Shell

A tiny native window around the server-hosted ClaudeOS web app. It **loads the remote URL**
(`http://localhost:4317`), so it is NOT a separate copy — every change Claude makes on the server
shows up instantly (just reload, `Ctrl+Shift+R`). Nothing to rebuild here when the UI changes.

## What it gives you over a Chrome tab

- **Full keyboard capture** — no browser menu, so `Ctrl+W`, `Ctrl+T`, `Ctrl+N`, `Ctrl+<number>`,
  etc. go to ClaudeOS instead of the browser. Bind any key you want.
- **Native desktop notifications** — pops a real OS toast when a session enters `WAITING_INPUT`,
  showing the task name + suggested answer. Click the toast → focuses the window.
- **Global summon hotkey** — `Ctrl+Alt+J` from *any* app brings ClaudeOS to the front.

- **LOCAL terminal (the big one)** — instead of streaming each task's terminal from the server over a
  WebSocket (the browser's only option, and the source of the reconnect/`[exited]` flakiness), the
  desktop app runs the terminal **on your computer**: it spawns a real local pty running
  `ssh -tt <host> 'tmux attach -t claudeos-<id>'` per task and renders it in the same embedded
  terminal. Bytes flow your laptop↔the server straight over **ssh + tmux** — battle-tested tools that own the
  connection — so the buggy custom streaming layer is out of the path entirely. Each task is its own
  durable tmux session (`claudeos-<id>`), so it survives deploys, disconnects, and reloads. The
  browser still works; it just keeps using the streamed WebSocket.

## What it does NOT do

- It does **not** by itself make typing *lower-latency* than the browser. Plain `ssh` typing is one
  the network round-trip, same as the WebSocket — the win here is **robustness**, not echo speed. For
  near-instant local echo, add **mosh** (install `mosh-server` on the server) — a separate follow-up.

## Install (one-time, on your Windows your laptop)

You need [Node.js](https://nodejs.org) (LTS) installed — that includes `npm`.

1. Get this `desktop/` folder onto your laptop. Easiest:
   ```
   scp -r <host>:~/code/claudeos/desktop  C:\claudeos-desktop
   ```
   (or copy the three files — `package.json`, `main.js`, `README.md` — into a new folder).
2. In that folder:
   ```
   npm install      # pulls Electron (~150 MB) + node-pty, and rebuilds node-pty for Electron (postinstall)
   npm start        # launches the app
   ```
   `npm install` runs `electron-rebuild` automatically (the `postinstall` script) so the native
   `node-pty` matches Electron's ABI. If the local terminal ever shows "node-pty not installed",
   run `npm run rebuild` once. If it can't build, the app still works — it falls back to the
   streamed WebSocket terminal.

   **The local terminal needs `ssh <host>` to work from your laptop** — i.e. a `Host <host>` entry in
   `C:\Users\<you>\.ssh\config` (or `~/.ssh/config`) with key-based login, so `ssh -tt <host> tmux`
   connects without a password prompt. Test it in a normal terminal first: `ssh <host> tmux ls`
   should list the `claudeos-*` sessions. Override the host with `set CLAUDEOS_SSH_HOST=<host>`.
3. The window opens on `http://localhost:4317`. If ClaudeOS is on a different host/port:
   ```
   set CLAUDEOS_URL=http://localhost:4317   &&  npm start      (Windows cmd)
   $env:CLAUDEOS_URL="http://localhost:4317"; npm start         (PowerShell)
   ```

## Notes

- Minimize (don't close) the window to keep getting notifications + the `Ctrl+Alt+J` hotkey.
- `Ctrl+Shift+R` = hard reload, `F12` = devtools, `Ctrl+Alt+Q` = quit. Everything else goes to ClaudeOS.
- Requires the network/network access to the server (`localhost`), same as the browser.
- This shell almost never changes — it just loads the remote URL. Update the URL via `CLAUDEOS_URL`.
