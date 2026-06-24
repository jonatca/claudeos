/**
 * DESKTOP TERMINAL-LEAK TEST — guards the 2026-06-16 "I see another session's output in a new
 * terminal, and Ctrl+Shift+R makes it WORSE" bug.
 *
 * Root cause was in the desktop Electron app (desktop/), not the host:
 *   - main.js held its ssh→tmux ptys in `terms` and killed them ONLY on app quit — never on a
 *     renderer reload. So every Ctrl+Shift+R left the old attaches ALIVE (leaked tmux clients).
 *   - preload.js reset its id counter to 0 each load, so a fresh "t1" collided with an orphaned
 *     "t1" that was still emitting term:data → that other session's bytes painted into the new xterm.
 *
 * The Electron half can't run headless, so we mock `electron` + `node-pty` and drive the REAL
 * desktop files: the ipcMain handlers, the did-start-navigation reaper, and preload's id generator.
 *
 *   node dist/test/desktop_term_leak_test.js
 */
import * as path from "path";
import { check, summary } from "./helpers";

// ── intercept require('electron') / require('node-pty') BEFORE loading the desktop files ──
const NodeModule: any = require("module");
const origLoad = NodeModule._load;

const ipcMainHandlers: Record<string, Function> = {};
const wcHandlers: Record<string, Function> = {};
let exposedNative: any = null;

// a fake node-pty: every spawn() is recorded and tracks whether it was kill()'d
const spawned: any[] = [];
function makePty() {
  const p: any = { killed: false, _data: null, _exit: null,
    onData(cb: Function) { p._data = cb; }, onExit(cb: Function) { p._exit = cb; },
    write() {}, resize() {}, kill() { p.killed = true; } };
  return p;
}
const ptyMock = { spawn: () => { const p = makePty(); spawned.push(p); return p; } };

const electronMock: any = {
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {}, whenReady: () => Promise.resolve(), quit: () => {}, setAppUserModelId: () => {},
  },
  BrowserWindow: class {
    webContents = {
      on: (ev: string, cb: Function) => { wcHandlers[ev] = cb; },
      send: () => {}, toggleDevTools: () => {}, setWindowOpenHandler: () => {},
      executeJavaScript: () => Promise.resolve(), reload: () => {},
    };
    on() {} loadURL() { return Promise.resolve(); } show() {} focus() {} isMinimized() { return false; } restore() {}
  },
  Menu: { setApplicationMenu: () => {} },
  globalShortcut: { register: () => {}, unregisterAll: () => {} },
  Notification: Object.assign(function () { return { on() {}, show() {} }; }, { isSupported: () => false }),
  shell: { openExternal: () => {} },
  ipcMain: { on: (ev: string, cb: Function) => { ipcMainHandlers[ev] = cb; } },
  // preload side:
  contextBridge: { exposeInMainWorld: (_name: string, obj: any) => { exposedNative = obj; } },
  ipcRenderer: { on: () => {}, send: () => {} },
};

NodeModule._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "electron") return electronMock;
  if (request === "node-pty") return ptyMock;
  return origLoad.call(this, request, parent, isMain);
};

const MAIN = path.join(__dirname, "../../desktop/main.js");
const PRELOAD = path.join(__dirname, "../../desktop/preload.js");
const fakeE = { sender: { send: () => {} } };
const openSpec = (id: string, sid: number) => ({ id, host: "server", remote: `tmux attach -t claudeos-${sid}`, cols: 80, rows: 24 });

(async () => {
  require(MAIN);
  // createWindow() runs inside app.whenReady().then(...) — flush the microtask so the
  // did-start-navigation handler is registered before we assert on it.
  await new Promise((r) => setImmediate(r));

  console.log("\n== main.js: a renderer reload reaps ALL ssh ptys (no orphaned tmux clients) ==");
  check("did-start-navigation handler was registered", typeof wcHandlers["did-start-navigation"] === "function");
  ipcMainHandlers["term:open"](fakeE, openSpec("t_a", 1));
  ipcMainHandlers["term:open"](fakeE, openSpec("t_b", 2));
  check("two ptys spawned for two open terminals", spawned.length === 2);
  check("neither pty killed while both terminals are live", !spawned[0].killed && !spawned[1].killed);
  // simulate Ctrl+Shift+R: a main-frame, NOT-in-place navigation
  wcHandlers["did-start-navigation"]({}, "http://localhost:4317", false, true);
  check("a reload killed BOTH ptys (the leak fix — they used to survive)", spawned[0].killed && spawned[1].killed);

  console.log("\n== main.js: the navigation guard doesn't over-fire ==");
  ipcMainHandlers["term:open"](fakeE, openSpec("t_c", 3));
  const c = spawned[spawned.length - 1];
  wcHandlers["did-start-navigation"]({}, "url#hash", true, true);   // in-place (hash) → must NOT kill
  check("an in-place (same-document) navigation does NOT kill the terminal", !c.killed);
  wcHandlers["did-start-navigation"]({}, "url", false, false);      // sub-frame → must NOT kill
  check("a sub-frame navigation does NOT kill the terminal", !c.killed);

  console.log("\n== main.js: term:open is collision-proof (recycled id kills the stale pty) ==");
  ipcMainHandlers["term:open"](fakeE, openSpec("dup", 5));
  const first = spawned[spawned.length - 1];
  ipcMainHandlers["term:open"](fakeE, openSpec("dup", 6));
  const second = spawned[spawned.length - 1];
  check("re-opening a recycled id kills the OLD pty first (no two ptys on one id)", first.killed && !second.killed);

  console.log("\n== preload.js: handle ids never recycle across a (re)load ==");
  const loadPreload = () => { delete require.cache[require.resolve(PRELOAD)]; exposedNative = null; require(PRELOAD); return exposedNative; };
  const n1 = loadPreload();
  const ids1 = [n1.openTerm({ host: "h", remote: "r" }).id, n1.openTerm({ host: "h", remote: "r" }).id];
  const n2 = loadPreload();
  const ids2 = [n2.openTerm({ host: "h", remote: "r" }).id, n2.openTerm({ host: "h", remote: "r" }).id];
  check("ids are unique within one load", ids1[0] !== ids1[1]);
  check("ids from two different loads NEVER collide (per-load tag — kills the bleed)",
    !ids1.some((x) => ids2.includes(x)));

  NodeModule._load = origLoad; // restore
  process.exit(summary());
})();
