/**
 * ClaudeOS desktop preload — exposes a LOCAL terminal bridge to the (server-hosted) renderer.
 *
 * The renderer normally streams each task's terminal from the server over a WebSocket.
 * Inside this desktop app it instead asks the server only for WHICH durable tmux session to attach
 * (`/api/term-spec` → `tmux attach -t claudeos-<id>` + the ssh host), then calls window.claudeosNative
 * to have the MAIN process spawn a real LOCAL pty running `ssh -t <host> <remote>`. So terminal bytes
 * flow your laptop↔the server straight over ssh + tmux — bypassing the server's WS and all its reconnect plumbing.
 *
 * node-pty lives in the MAIN process (it's a native module); this preload only talks to it over IPC,
 * so it works even under the default Electron sandbox (only `electron` is required here).
 */
const { contextBridge, ipcRenderer } = require("electron");

// Per-LOAD random tag so terminal handle ids can NEVER recycle across a reload. Before this, `_seq`
// reset to 0 on every page load while the MAIN process still held the previous load's live ptys under
// "t1","t2",… — so a new "t1" collided with an orphaned "t1" and that other session's bytes painted
// into this xterm. With a fresh tag per load, ids from different loads can't collide even if a stray
// pty outlives its renderer. (main.js also kills all ptys on navigation now — defence in depth.)
const _loadTag = Math.random().toString(36).slice(2, 8);
let _seq = 0;
const dataCbs = new Map(); // id -> (chunk) => void
const exitCbs = new Map(); // id -> () => void
const earlyData = new Map(); // id -> chunk[]  (buffer bytes that arrive before onData() is wired)

ipcRenderer.on("term:data", (_e, id, chunk) => {
  const cb = dataCbs.get(id);
  if (cb) { cb(chunk); return; }
  const q = earlyData.get(id) || []; q.push(chunk); earlyData.set(id, q); // hold until the renderer subscribes
});
ipcRenderer.on("term:exit", (_e, id) => { const cb = exitCbs.get(id); if (cb) cb(); });

// FIX WD (desktop): the MAIN process catches keys Chromium would otherwise eat before the page
// (e.g. Alt+Backspace = Windows "undo") and forwards the byte(s) to inject. Bridge it to a single
// renderer-registered callback so renderer.ts can route it through the live terminal transport.
let _injectCb = null;
ipcRenderer.on("claudeos:inject-input", (_e, d) => { if (_injectCb) try { _injectCb(d); } catch {} });

contextBridge.exposeInMainWorld("claudeosNative", {
  available: true,
  /** Register a single handler for input the MAIN process injects (e.g. Alt+Backspace → 0x17). */
  onInjectInput(cb) { _injectCb = cb; },
  /** Spawn `ssh -t <host> <remote>` in a LOCAL pty. Returns a handle id used by the other calls. */
  openTerm({ host, remote, cols, rows }) {
    const id = "t" + _loadTag + "_" + (++_seq);
    ipcRenderer.send("term:open", { id, host, remote, cols: cols || 120, rows: rows || 30 });
    return { id };
  },
  onData(id, cb) {
    dataCbs.set(id, cb);
    const q = earlyData.get(id); // flush anything that arrived before this subscription
    if (q) { earlyData.delete(id); for (const c of q) { try { cb(c); } catch {} } }
  },
  onExit(id, cb) { exitCbs.set(id, cb); },
  write(id, data) { ipcRenderer.send("term:write", id, data); },
  resize(id, cols, rows) { ipcRenderer.send("term:resize", id, cols, rows); },
  close(id) { ipcRenderer.send("term:close", id); dataCbs.delete(id); exitCbs.delete(id); earlyData.delete(id); },
});
