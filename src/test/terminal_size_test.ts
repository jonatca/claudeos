/**
 * TERMINAL-SIZE E2E — guards the "new terminal renders full-size, not a tiny 80×24 box in the
 * top-left corner" fix (2026-06-09). This is a BEHAVIORAL test against real tmux, not a string
 * match: it reproduces the exact bug precondition and proves the fix actually resizes the window.
 *
 * THE BUG: a freshly-launched session's tmux window is created at tmux's 80×24 default, and the
 * WS-fallback attach uses `attach-session -f ignore-size` (so a stray 2nd client can't shrink OUR
 * dedicated per-task session). With ignore-size the attaching xterm ALSO can't grow the window —
 * so it stayed locked at 80×24 and `claude` drew a tiny box in the top-left of a big xterm.
 *
 * THE FIX: ensureAttachSpec returns `resizeName` for the dedicated cockpit session, and the server
 * `resize-window`s it to the client's size on attach AND on every live resize. A foreign live pane
 * (the operator's OWN terminal) must NEVER get resizeName.
 *
 * Drives the REAL SessionManager.ensureAttachSpec so a future refactor of the argv/flags is still
 * covered — the test uses whatever spec the code returns and asserts the WINDOW ends up correct.
 *
 *   node dist/test/terminal_size_test.js
 */
import { execFileSync } from "child_process";
import * as os from "os";
import * as pty from "node-pty";
import { SessionManager } from "../core/sessions";
import { SessionRow } from "../core/db";
import { check, summary } from "./helpers";
import { sleep } from "./e2e_boot";

function haveTmux(): boolean {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
}

/** Minimal SessionRow for ensureAttachSpec (non-demo only reads .branch / .is_live_pane / pane fields). */
function rowFor(branch: string, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 1, slot: 1, title: "t", repo: "r", worktree_path: os.tmpdir(), branch,
    claude_session_id: null, transcript_path: null, pid: null,
    pane_id: null, tmux_target: null, is_live_pane: 0, clean_title: null,
    state: "WORKING" as any, blocks_other_work: 0, deadline: null, kind: "claude",
    pr_repo: null, pr_number: null, pr_url: null, pr_author: null,
    discovered: 0, manual_importance: null, pinned: 0,
    ...extra,
  } as SessionRow;
}

const winSize = (name: string): string =>
  execFileSync("tmux", ["display-message", "-p", "-t", name, "#{window_width}x#{window_height}"], { encoding: "utf8" }).trim();

const kill = (name: string) => { try { execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" }); } catch {} };

/** Attach to `name` exactly like the server does — pty.spawn("tmux", spec.argv, {cols, rows}) — and
 *  optionally run the resize-window the fix performs. Returns the inner window size after settle. */
async function attachAndMaybeResize(argv: string[], resizeName: string | undefined, name: string, cols: number, rows: number, doResize: boolean): Promise<string> {
  const term = pty.spawn("tmux", argv, { name: "xterm-256color", cols, rows });
  await sleep(500);
  if (doResize && resizeName) {
    try { execFileSync("tmux", ["resize-window", "-t", resizeName, "-x", String(cols), "-y", String(rows)], { stdio: "ignore" }); } catch {}
    await sleep(300);
  }
  const sz = winSize(name);
  try { term.kill(); } catch {}
  await sleep(200);
  return sz;
}

async function run() {
  if (!haveTmux()) { console.log("\n== Terminal size E2E ==\n  (skipped — tmux not available)"); return; }

  const sm = new SessionManager(null as any, false);
  const CLIENT_COLS = 225, CLIENT_ROWS = 78;

  console.log("\n== New-terminal window sizing (real tmux) ==");

  // ── Reproduce the bug precondition: a cockpit session created at tmux's 80×24 DEFAULT, exactly
  //    like launchTerminalSession (`new-session -d` with NO -x/-y). ──────────────────────────────
  const slug = "clos-szt-" + process.pid;
  const name = `cockpit-${slug}`;
  kill(name);
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-c", os.tmpdir(),
    // a long-lived inner program (NOT claude — keep the test hermetic) that just holds the pane open
    `while true; do sleep 1; done`], { stdio: "ignore" });
  try {
    check("precondition: a freshly-launched cockpit session starts at tmux's 80×24 default", winSize(name) === "80x24", winSize(name));

    // ── The REAL spec the server uses for this dedicated session. ──────────────────────────────
    const spec = sm.ensureAttachSpec(rowFor(`cockpit/${slug}`));
    check("ensureAttachSpec resolves the dedicated cockpit session", !!spec, JSON.stringify(spec));
    check("dedicated attach keeps `-f ignore-size` (a stray 2nd client can't shrink it)", !!spec && spec.argv.includes("ignore-size"));
    check("dedicated attach carries resizeName === the canonical session name (so the server can size it)", !!spec && spec.resizeName === name, spec?.resizeName);

    // ── NEGATIVE CONTROL: the bug itself. Attach with the real argv (ignore-size) but DON'T resize
    //    → proves ignore-size alone leaves the window stuck at 80×24 (claude → tiny top-left box).
    //    If this ever passes at full size, ignore-size was dropped and the resize is masking it. ──
    const stuck = await attachAndMaybeResize(spec!.argv, spec!.resizeName, name, CLIENT_COLS, CLIENT_ROWS, /*doResize*/ false);
    check("BUG REPRO: ignore-size attach WITHOUT the resize leaves the window at 80×24", stuck === "80x24", stuck);

    // ── THE FIX: same attach + the server's resize-window → the window (and claude) fill the xterm.
    const fixed = await attachAndMaybeResize(spec!.argv, spec!.resizeName, name, CLIENT_COLS, CLIENT_ROWS, /*doResize*/ true);
    check(`FIX: attach + resize-window grows the window to the client size (${CLIENT_COLS}×${CLIENT_ROWS})`,
      fixed === `${CLIENT_COLS}x${CLIENT_ROWS}`, fixed);

    // ── A DIFFERENT client size also tracks (guards a hardcoded size sneaking in). ──────────────
    const fixed2 = await attachAndMaybeResize(spec!.argv, spec!.resizeName, name, 140, 50, /*doResize*/ true);
    check("FIX: a different client size (140×50) is tracked too (no hardcoded dimensions)", fixed2 === "140x50", fixed2);
  } finally {
    kill(name);
  }

  // ── A FOREIGN live pane is the operator's OWN terminal — it must NEVER carry resizeName, or we'd
  //    shrink/grow their real terminal out from under them. ────────────────────────────────────────
  console.log("\n== Foreign live pane is never resized ==");
  const foreign = sm.ensureAttachSpec(rowFor("some/other-branch", { is_live_pane: 1, tmux_target: "operator:0.1", pane_id: "%9" } as Partial<SessionRow>));
  check("foreign live-pane attach uses ignore-size", !!foreign && foreign.argv.includes("ignore-size"));
  check("foreign live-pane attach has NO resizeName (never resize the operator's own pane)", !!foreign && foreign.resizeName === undefined, foreign?.resizeName);
}

run().then(() => process.exit(summary())).catch((e) => { console.error(e); process.exit(1); });
