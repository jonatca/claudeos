/**
 * ClaudeOS desktop shell — a THIN native window around the server-hosted ClaudeOS web app.
 *
 * It does NOT bundle the UI. It loads the remote URL (default http://localhost:4317), so every
 * change made on the server is instant here (just reload) — nothing to rebuild on the client.
 *
 * What it adds over a browser tab:
 *   1. FULL KEYBOARD CAPTURE — no browser menu, so Ctrl+W / Ctrl+T / Ctrl+N etc. go to the
 *      web app instead of the browser. Bind anything you want in ClaudeOS.
 *   2. NATIVE OS NOTIFICATIONS — polls /api/state and pops a real desktop toast when a session
 *      enters WAITING_INPUT, showing the task name + the suggested answer. Click → focus window.
 *   3. GLOBAL SUMMON HOTKEY — Ctrl+Alt+J from any app brings ClaudeOS to the front.
 *
 * It does NOT make the terminal faster (same Chromium renderer, same WebSocket transport).
 *
 * Config via env: CLAUDEOS_URL (default http://localhost:4317), CLAUDEOS_SSH_HOST.
 */
const { app, BrowserWindow, Menu, globalShortcut, Notification, shell, ipcMain } = require("electron");
const http = require("http");
const path = require("path");

// node-pty is a NATIVE module — install it in desktop/ and rebuild for this Electron's ABI
// (`npm install` then `npx @electron/rebuild -f -w node-pty`). If it's missing we degrade
// gracefully: local-terminal IPC still registers but spawning fails, so the renderer's
// openTermNative() catches it and falls back to the streamed WebSocket.
let pty = null;
try { pty = require("node-pty"); } catch (e) { console.warn("[claudeos] node-pty unavailable — local terminal will fall back to streamed WS:", e && e.message); }
const SSH_HOST_DEFAULT = process.env.CLAUDEOS_SSH_HOST || "localhost"; // overridable; usually a ~/.ssh/config Host alias
const _fs = require("fs");
// ConPTY (node-pty on Windows) does NOT search %PATH% for the executable like a shell does — pass
// an ABSOLUTE path or WindowsPtyAgent throws "file not found". Resolve ssh.exe across common spots.
function resolveSsh() {
  const c = [process.env.CLAUDEOS_SSH_EXE, "C:\\Windows\\System32\\OpenSSH\\ssh.exe", "C:\\Program Files\\Git\\usr\\bin\\ssh.exe", "/usr/bin/ssh"].filter(Boolean);
  for (const p of c) { try { if (_fs.existsSync(p)) return p; } catch {} }
  return "ssh";
}

// ClaudeOS mark on a dark rounded tile.
const ICON = path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png");

const COCKPIT_URL = (process.env.CLAUDEOS_URL || "http://localhost:4317").replace(/\/+$/, "");
const STATE_URL = COCKPIT_URL + "/api/state";
const POLL_MS = 4000;
const SUMMON_HOTKEY = "CommandOrControl+Alt+J";

let win = null;
const notified = new Set(); // session ids already toasted as WAITING_INPUT (so we don't repeat)

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    backgroundColor: "#0b0d12",
    title: "ClaudeOS",
    icon: ICON,
    autoHideMenuBar: true,
    // preload exposes window.claudeosNative (the LOCAL ssh→tmux terminal bridge) to the remote page.
    webPreferences: { spellcheck: false, preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });

  // No application menu → frees Ctrl+W / Ctrl+T / Ctrl+N / Ctrl+number etc. so the web app's
  // own key handlers (your master key, vim keys, anything) receive EVERY combination.
  Menu.setApplicationMenu(null);

  win.loadURL(COCKPIT_URL).catch(() => {});

  // LEAK FIX: a top-level (re)load throws away the renderer and every terminal handle it held, but the
  // MAIN process (and its `terms` ptys) survives. Kill the ssh→tmux ptys the instant the page starts
  // navigating away, BEFORE the new renderer opens fresh ones — so Ctrl+Shift+R can't orphan attaches
  // (leaked tmux clients) or recycle ids that collide with a still-alive pty. Initial load: terms is
  // empty → no-op. Guard to a real main-frame document load (not an in-page hash change).
  win.webContents.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) killAllTerms();
  });
  // A renderer crash (render-process-gone) likewise abandons all handles → reap the ptys.
  win.webContents.on("render-process-gone", () => killAllTerms());

  // Escape hatches the web app doesn't use, handled here; everything else falls through to the page.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = input.control || input.meta;
    const k = (input.key || "").toLowerCase();
    if (input.key === "F12") { win.webContents.toggleDevTools(); event.preventDefault(); }
    else if (mod && input.shift && k === "r") { win.reload(); event.preventDefault(); }       // hard reload
    else if (mod && input.alt && k === "q") { app.quit(); event.preventDefault(); }            // quit (Ctrl+Alt+Q)
    // FIX WD (desktop): Alt+Backspace → DELETE THE PREVIOUS WORD. On Windows, Chromium consumes
    // Alt+Backspace as the OS "undo" edit accelerator BEFORE it ever dispatches a keydown to the
    // page — so the renderer's xterm handler never fires and word-delete silently does nothing.
    // before-input-event runs in the MAIN process ahead of that, so we catch it here, swallow it,
    // and tell the renderer to send 0x17 (the exact byte Ctrl+W sends → word-rubout) through
    // whichever terminal transport is live. (Plain browser users keep the in-page xterm handler.)
    else if (input.alt && !input.control && !input.meta && input.key === "Backspace") {
      event.preventDefault();
      try { win.webContents.send("claudeos:inject-input", "\x17"); } catch {}
    }
    // NOTE: plain Ctrl+W, Ctrl+T, Ctrl+G, etc. are deliberately NOT intercepted → the web app gets them.
  });

  // Retry if ClaudeOS isn't reachable yet (server restarting, VPN reconnecting, …).
  win.webContents.on("did-fail-load", (_e, _code, _desc, url) => {
    if (url && url.startsWith(COCKPIT_URL)) setTimeout(() => { if (win) win.loadURL(COCKPIT_URL).catch(() => {}); }, 2500);
  });

  // External links open in the real browser, not a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(COCKPIT_URL)) return { action: "allow" };
    shell.openExternal(url); return { action: "deny" };
  });

  win.on("closed", () => { win = null; });
}

// ---- Native notification when a session needs you (polls /api/state, no web-app changes needed) ----
function poll() {
  const req = http.get(STATE_URL, (res) => {
    let buf = "";
    res.on("data", (d) => (buf += d));
    res.on("end", () => {
      let d;
      try { d = JSON.parse(buf); } catch { return; }
      const queue = Array.isArray(d.queue) ? d.queue : [];
      const waitingNow = new Set();
      for (const it of queue) {
        if (it.state !== "WAITING_INPUT") continue;
        const id = String(it.session_id || it.id);
        waitingNow.add(id);
        if (notified.has(id)) continue;
        notified.add(id);
        const s = it.session || {};
        const title = s.clean_title || s.title || "A session needs you";
        const ask = it.one_liner || it.question || (it.context || "").toString().slice(0, 120);
        const sug = it.suggested_answer ? `\n💡 ${String(it.suggested_answer).slice(0, 120)}` : "";
        if (Notification.isSupported()) {
          const n = new Notification({ title: `🟡 ${title}`, body: `${ask}${sug}`.trim() || "Waiting for your input" });
          n.on("click", () => { if (win) { win.show(); win.focus(); } });
          n.show();
        }
      }
      // Forget sessions that are no longer waiting, so they can re-notify next time.
      for (const id of [...notified]) if (!waitingNow.has(id)) notified.delete(id);
    });
  });
  req.on("error", () => {});
  req.setTimeout(3000, () => req.destroy());
}

// ---- LOCAL terminal: spawn `ssh -t <host> <remote>` in a real pty per task (node-pty in MAIN) ----
// The renderer asks the server for { host, remote } (remote = `tmux attach -t claudeos-<id>`), then
// drives this over IPC. `remote` is passed to ssh as ONE argv element, so the remote login shell
// parses it — no nested quoting, and `-tt` forces a tty so tmux/claude render correctly.
const terms = new Map(); // id -> node-pty
// Kill every live ssh→tmux pty and forget them. Called on app quit AND on any renderer (re)load —
// see the did-start-navigation handler in createWindow(). THE LEAK FIX: before this, ptys were only
// killed on app quit, so every Ctrl+Shift+R left the previous renderer's attaches ALIVE in `terms`,
// piling up leaked tmux clients; and because preload reset its id counter per load, a fresh "t1"
// collided with an orphaned "t1" still emitting → ANOTHER session's bytes painted into the new
// terminal ("I see other things there"). Reloading made it worse, not better.
function killAllTerms() {
  for (const t of terms.values()) { try { t.kill(); } catch {} }
  terms.clear();
}
ipcMain.on("term:open", (e, { id, host, remote, cols, rows }) => {
  if (!pty) { try { e.sender.send("term:data", id, "\r\n\x1b[31mnode-pty not installed in desktop/ — run `npm install` + `npx @electron/rebuild`\x1b[0m\r\n"); e.sender.send("term:exit", id); } catch {} return; }
  // Collision-proof: if a pty already holds this id, kill it first so two ptys can never feed one id.
  const existing = terms.get(id); if (existing) { try { existing.kill(); } catch {} terms.delete(id); }
  let term;
  try {
    term = pty.spawn(resolveSsh(), ["-tt", host || SSH_HOST_DEFAULT, remote], {
      name: "xterm-256color", cols: cols || 120, rows: rows || 30,
      cwd: process.env.HOME || process.env.USERPROFILE || undefined, env: process.env,
    });
  } catch (err) {
    try { e.sender.send("term:data", id, `\r\n\x1b[31mssh spawn failed: ${String(err && err.message || err)}\x1b[0m\r\n`); e.sender.send("term:exit", id); } catch {}
    return;
  }
  terms.set(id, term);
  term.onData((d) => { try { e.sender.send("term:data", id, d); } catch {} });
  term.onExit(() => { try { e.sender.send("term:exit", id); } catch {} terms.delete(id); });
});
ipcMain.on("term:write", (_e, id, data) => { const t = terms.get(id); if (t) try { t.write(data); } catch {} });
ipcMain.on("term:resize", (_e, id, cols, rows) => { const t = terms.get(id); if (t && cols > 0 && rows > 0) try { t.resize(cols, rows); } catch {} });
ipcMain.on("term:close", (_e, id) => { const t = terms.get(id); if (t) { try { t.kill(); } catch {} terms.delete(id); } });
app.on("will-quit", () => killAllTerms());

// SINGLE-INSTANCE LOCK — the fix for the Windows cache-error spam.
// Each full Electron instance points at the same %APPDATA%\claudeos-desktop userData dir.
// Launch a 2nd instance while the 1st is alive and Chromium can't get exclusive access to
// the cache → "Unable to move the cache: Access is denied (0x5)" / "Gpu Cache Creation failed: -2"
// (and orphaned electron.exe processes pile up). With the lock, a 2nd launch just focuses the
// window that's already running instead of spawning a competing instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) createWindow();
    else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("com.claudeos.desktop"); // needed for Windows toasts
    createWindow();
    setInterval(poll, POLL_MS);

    // Summon ClaudeOS from any app.
    globalShortcut.register(SUMMON_HOTKEY, () => {
      if (!win) createWindow();
      win.show(); win.focus();
      // best-effort: if the web app exposes a "jump to top of the needs-you queue" hook, call it.
      win.webContents.executeJavaScript("window.__claudeosFocusTop && window.__claudeosFocusTop()").catch(() => {});
    });
  });
}

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("activate", () => { if (!win) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
