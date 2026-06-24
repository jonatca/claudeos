/**
 * TERM-MODE REPLAY TEST — guards the "can't scroll a reopened terminal until you maximize it
 * once" fix (2026-06-10). A kept-alive direct pty replays only the last 200KB of output on
 * reopen; tmux's mouse-enable DECSETs live at the HEAD of the stream, so the replayed tail no
 * longer contains them and the fresh xterm never enters mouse-tracking mode → wheel dead.
 * TermModeTracker watches the stream and synthesizes a re-assert prefix for the replay.
 *
 * Two rings:
 *   1. unit — tracker semantics on synthetic streams (slice loss, latest-wins, split escapes…)
 *   2. REAL tmux — attach a real pty (own socket, own config: hermetic) and prove (a) tmux
 *      asserts the mouse DECSETs only at the attach HEAD, (b) the tracker captures them from
 *      tmux's actual bytes, (c) a SAME-size reopen gets nothing from tmux (why the bug didn't
 *      heal itself) — the external behavior the whole fix rests on.
 *
 *   node dist/test/termmodes_test.js
 */
import { execFileSync } from "child_process";
import * as os from "os";
import * as pty from "node-pty";
import { TermModeTracker } from "../core/termmodes";
import { check, summary } from "./helpers";
import { sleep } from "./e2e_boot";

function run() {
  console.log("\n== TermModeTracker (mouse/alt-screen state survives the 200KB replay slice) ==");

  // ── the real-world failure: tmux asserts modes once at attach, then >200KB of output ──
  const t = new TermModeTracker();
  const attachHead = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h"; // what tmux sends on attach
  let buffer = "";
  const feed = (d: string) => { buffer = (buffer + d).slice(-200000); t.feed(d); }; // mirrors server.ts
  feed(attachHead);
  for (let i = 0; i < 350; i++) feed("x".repeat(1000) + "\r\n"); // 350KB of session output
  check("the 200KB buffer tail LOST the attach-time DECSETs (the bug precondition)",
    !buffer.includes("\x1b[?1000h"));
  const prefix = t.reassertPrefix();
  check("re-assert prefix restores mouse tracking (?1000h)", prefix.includes("\x1b[?1000h"));
  check("re-assert prefix restores SGR mouse encoding (?1006h)", prefix.includes("\x1b[?1006h"));
  check("re-assert prefix restores bracketed paste (?2004h)", prefix.includes("\x1b[?2004h"));
  check("alt-screen (?1049h) comes FIRST so replayed content lands in the right buffer",
    prefix.startsWith("\x1b[?1049h"));

  // ── latest value wins: a mode toggled off later replays as OFF ──
  const t2 = new TermModeTracker();
  t2.feed("\x1b[?1000h\x1b[?2004h");
  t2.feed("\x1b[?1000l");
  check("a later DECRST overrides the earlier DECSET (?1000 replays as l)",
    t2.reassertPrefix().includes("\x1b[?1000l") && !t2.reassertPrefix().includes("\x1b[?1000h"));

  // ── multi-param DECSET (apps combine: \x1b[?1000;1006h) ──
  const t3 = new TermModeTracker();
  t3.feed("\x1b[?1000;1006h");
  check("multi-param DECSET sets every listed mode",
    t3.reassertPrefix().includes("\x1b[?1000h") && t3.reassertPrefix().includes("\x1b[?1006h"));

  // ── escape sequences split across chunk boundaries ──
  const t4 = new TermModeTracker();
  t4.feed("some output\x1b[?10");
  t4.feed("06h more output");
  check("a DECSET split across two chunks is still tracked",
    t4.reassertPrefix().includes("\x1b[?1006h"));

  // ── untouched modes are NOT forged (raw `claude --resume` pty never set mouse mode) ──
  const t5 = new TermModeTracker();
  t5.feed("plain output, no modes\r\n\x1b[2K\x1b[1G");
  check("a stream that never set a mode replays an EMPTY prefix (no forged state)",
    t5.reassertPrefix() === "");

  // ── irrelevant private modes are ignored ──
  const t6 = new TermModeTracker();
  t6.feed("\x1b[?9001h\x1b[?12h"); // win32-input / cursor-blink — not UX state we replay
  check("non-whitelisted modes never appear in the prefix", t6.reassertPrefix() === "");
}

// ───────────────────────── ring 2: REAL tmux byte stream ─────────────────────────
const SOCK = "clos-termmodes-" + process.pid;
const SESSION = "termmodes-test";
const T = (args: string[], opts: any = {}): string => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TMUX; delete env.TMUX_PANE;
  return execFileSync("tmux", ["-L", SOCK, "-f", "/dev/null", ...args], { encoding: "utf8", env, ...opts }) as string;
};
function haveTmux(): boolean {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function runRealTmux() {
  if (!haveTmux()) { console.log("\n== real tmux ==\n  (skipped — tmux not available)"); return; }
  console.log("\n== REAL tmux: attach-head DECSETs + same-size-reopen silence ==");
  try { T(["kill-server"], { stdio: "ignore" }); } catch {}
  // hermetic: own socket + `-f /dev/null` (no operator config), mouse enabled explicitly
  T(["new-session", "-d", "-s", SESSION, "-x", "120", "-y", "36", "bash", "--norc", "-i"]);
  T(["set", "-g", "mouse", "on"]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TMUX; delete env.TMUX_PANE;
  const client = pty.spawn("tmux", ["-L", SOCK, "-f", "/dev/null", "attach-session", "-t", SESSION],
    { name: "xterm-256color", cols: 120, rows: 36, env });
  let bytes = "";
  const tracker = new TermModeTracker();
  client.onData((d) => { bytes += d; tracker.feed(d); });
  await sleep(1200);

  // (a) the bug precondition: mouse DECSETs are sent ONCE, at the attach head
  check("real tmux asserts SGR mouse tracking at attach (?1000h + ?1006h in the head)",
    bytes.includes("\x1b[?1000h") && bytes.includes("\x1b[?1006h"));
  check("real tmux enters the alt screen at attach (?1049h)", bytes.includes("\x1b[?1049h"));

  // (b) the tracker captures the modes from tmux's ACTUAL bytes (not our synthetic strings)
  const prefix = tracker.reassertPrefix();
  check("TermModeTracker captures tmux's real attach modes (prefix re-asserts ?1000h/?1006h/?1049h)",
    prefix.includes("\x1b[?1000h") && prefix.includes("\x1b[?1006h") && prefix.includes("\x1b[?1049h"));

  // (c) why the bug never healed: a SAME-size resize (what a plain reopen amounts to) makes
  // tmux emit NO mode re-asserts — only a REAL size change would. The replay prefix is the
  // only thing standing between a reopened xterm and dead scrolling.
  bytes = "";
  try { client.resize(120, 36); } catch {}
  await sleep(700);
  check("same-size reopen/resize gets NO mode re-assert from tmux (the replay prefix must supply it)",
    !bytes.includes("\x1b[?1000h") && !bytes.includes("\x1b[?1006h"));

  try { client.kill(); } catch {}
  await sleep(150);
  try { T(["kill-server"], { stdio: "ignore" }); } catch {}
}

(async () => {
  run();
  try {
    await runRealTmux();
  } finally {
    try { T(["kill-server"], { stdio: "ignore" }); } catch {}
  }
  process.exit(summary());
})();
