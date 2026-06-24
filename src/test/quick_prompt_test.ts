/**
 * QUICK-PROMPT (Ctrl+G i) — guards the "fire a new Claude session in the background from a tiny
 * inline overlay, then return to whatever you were doing" feature.
 *
 * THE FEATURE: Ctrl+G i opens a small overlay; you type a prompt and press Enter. That launches a
 * BRAND-NEW Claude session seeded with the prompt as claude's first CLI arg (so it auto-submits
 * the instant the TUI boots — no send-keys timing race), WITHOUT switching the view to that
 * terminal. Focus snaps back to the pane you were on.
 *
 * Two rings, both deterministic (no `claude`/tmux needed):
 *   1. claudeLaunchCmd() — the pure command-builder: correct flag + JSON-quoted seed prompt,
 *      blank/whitespace prompt = no seed, shell-special chars stay safely quoted.
 *   2. wiring source-guards — the renderer binds Ctrl+G i → showQuickPrompt, the submit path
 *      calls api.newSession("claude", text, importance) WITHOUT openTerminalView, restores focus,
 *      and the IPC/preload/server/webapi newSession surface all thread the optional prompt AND the
 *      optional Ctrl+Enter priority (0–100 manual importance, blank = none) through.
 *
 *   node dist/test/quick_prompt_test.js
 */
import * as fs from "fs";
import * as path from "path";
import { claudeLaunchCmd, keepAliveWrap } from "../core/sessions";
import { check, eq, summary } from "./helpers";

function src(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");
}

function run() {
  console.log("\n== Quick-prompt (Ctrl+G i) ==");

  // --- ring 1: the pure command-builder ----------------------------------------------------
  eq("empty terminal: skip-perms, no seed", claudeLaunchCmd(true), "claude --dangerously-skip-permissions");
  eq("no skip-perms, no seed", claudeLaunchCmd(false), "claude");
  eq("blank prompt = no seed", claudeLaunchCmd(true, "   "), "claude --dangerously-skip-permissions");
  eq(
    "seed prompt is appended single-quoted (auto-submit at boot)",
    claudeLaunchCmd(true, "fix the build"),
    "claude --dangerously-skip-permissions 'fix the build'"
  );
  eq("seed prompt is trimmed", claudeLaunchCmd(true, "  hello  "), "claude --dangerously-skip-permissions 'hello'");
  // $VAR / backticks / $(…) must NOT expand — single quotes keep the prompt fully literal.
  eq("seed neutralizes $VAR and command substitution", claudeLaunchCmd(false, 'echo $HOME `whoami` $(id)'), "claude 'echo $HOME `whoami` $(id)'");
  // an embedded single quote is escaped as '\'' so the wrapping stays balanced.
  eq("seed escapes embedded single quotes", claudeLaunchCmd(false, "it's done"), "claude 'it'\\''s done'");

  // --- keepAliveWrap: a claude that exits (crash at boot OR clean quit) must NOT take the tmux
  // pane — and its error output — with it; a FAST nonzero exit (boot crash) is auto-retried.
  const wrapped = keepAliveWrap(claudeLaunchCmd(true, "fix the build"));
  check("keepAliveWrap embeds the unmodified launch command", wrapped.includes("claude --dangerously-skip-permissions 'fix the build'; "));
  check("keepAliveWrap captures the exit status", wrapped.includes('rc=$?'));
  check("keepAliveWrap keeps the pane alive via exec bash", wrapped.endsWith("exec bash"));
  check("keepAliveWrap: clean exit (rc=0) never retries", wrapped.includes('[ "$rc" -eq 0 ] && break'));
  check("keepAliveWrap: a death AFTER the boot window never retries", wrapped.includes('-ge 15 ] && break'));
  check("keepAliveWrap: boot crashes are retried (bounded)", wrapped.includes("auto-retry") && wrapped.includes('[ "$_n" -gt 2 ] && break'));
  check("keepAliveWrap: POSIX sh only — no bashism $SECONDS", !wrapped.includes("$SECONDS"));
  check("keepAliveWrap: a final failure says so explicitly (FAILED, card preserved)", wrapped.includes("claude FAILED") && wrapped.includes("stay on the board"));
  // DURABLE PROMPT: the task text is echoed as the pane's first line — readable even if claude
  // never boots — and quoted so $VAR/`cmd` in the prompt can't expand.
  const seeded = keepAliveWrap(claudeLaunchCmd(true, "fix the build"), "fix the $BUILD now");
  check("keepAliveWrap echoes the seed prompt first", seeded.startsWith("printf '[task] %s\\n' 'fix the $BUILD now'; "));
  check("keepAliveWrap: no seed prompt → no echo", !wrapped.includes("[task]"));
  // wiring: BOTH tmux launch paths (quick-prompt terminal + kanban/detail launch) use the wrapper.
  const sess = src("src/core/sessions.ts");
  check("launchTerminalSession wraps the claude cmd + passes the seed echo", /keepAliveWrap\(claudeLaunchCmd\(opts\.skipPermissions, opts\.prompt\), opts\.prompt\)/.test(sess));
  // launch() routes through claudeLaunchCmd too (shQuotes internally — same no-expansion
  // guarantee, plus the kanban auto-start can pass skipPermissions): the wrapped call appears
  // in BOTH launch paths and the raw `claude ${...}` template is gone.
  check("launch() wraps + shQuotes the seed prompt (no JSON.stringify expansion hole)",
    (sess.match(/keepAliveWrap\(claudeLaunchCmd\(opts\.skipPermissions, opts\.prompt\), opts\.prompt\)/g) || []).length >= 2 && !sess.includes("`claude ${shQuote(opts.prompt)}`"));
  // DURABLE PROMPT on the card: a seeded launch titles the row with the OPERATOR'S WORDS, so the
  // written task is on the board from the instant it exists (never reduced to a dead process arg).
  check("launchTerminalSession titles a seeded session with the prompt", /const title = seeded \? opts\.prompt!\.trim\(\)/.test(sess));
  check("a seeded session is never provisional", /const provisional = seeded \? 0 : 1/.test(sess));
  check("slug/tmux/worktree names stay on the FIXED base title", /const slug = slugify\(baseTitle\) \+ "-" \+ nextId/.test(sess));

  // --- ring 2: renderer + plumbing wiring guards -------------------------------------------
  const rjs = src("src/renderer/renderer.ts");
  check("renderer: Ctrl+G i (master 'i') opens the quick prompt", /e\.key === "i"[^\n]*showQuickPrompt\(\)/.test(rjs));
  check("renderer: showQuickPrompt opens the quickprompt-overlay", /function showQuickPrompt\(\)[^]*?quickprompt-overlay[^]*?display = "block"/.test(rjs));
  check("renderer: submit launches a Claude session SEEDED with the typed text + optional priority", /api\.newSession\("claude",\s*text,\s*importance\)/.test(rjs));
  check("renderer: submit does NOT switch the view (no openTerminalView in submitQuickPrompt)", /function submitQuickPrompt\(\)[^]*?\}/.test(rjs) && !/function submitQuickPrompt\(\)[^]*?openTerminalView/.test(rjs));
  check("renderer: submit restores keyboard focus to where you were", /function submitQuickPrompt\(\)[^]*?applyKeyboardTarget\(\)/.test(rjs));
  check("renderer: a document-level focus trap covers clicks OUTSIDE the small overlay box", /wireQuickPromptFocusLock[^]*?overlayOpen\(\) !== "quickprompt-overlay"[^]*?contains\(e\.target[^]*?preventDefault\(\)[^]*?stopPropagation\(\)[^]*?focus\(\)/.test(rjs));
  check("renderer: the focus trap listens in capture phase for mousedown + click", /addEventListener\("mousedown", lock, true\)[^]*?addEventListener\("click", lock, true\)/.test(rjs));
  check("renderer: showQuickPrompt arms the focus trap", /function showQuickPrompt\(\)[^]*?wireQuickPromptFocusLock\(\)/.test(rjs));
  check("renderer: plain Enter submits; Shift+Enter newlines; Ctrl/Cmd+Enter reveals the priority field", /quickprompt-overlay" && e\.key === "Enter"[^]*?if \(e\.shiftKey\) return;[^]*?e\.ctrlKey \|\| e\.metaKey[^]*?revealQuickPromptPriority\(\)[^]*?submitQuickPrompt\(\)/.test(rjs));
  check("renderer: quickprompt-overlay is in overlayOpen + closeOverlays lists", (rjs.match(/"quickprompt-overlay"/g) || []).length >= 3);

  // --- PRIORITY (Ctrl+Enter → set a 0–100 importance, then Enter sends with it; blank = none) ---
  check("renderer: Ctrl+Enter reveals the priority field & focuses it", /function revealQuickPromptPriority\(\)[^]*?quickprompt-prio-row[^]*?display = "flex"[^]*?quickprompt-prio[^]*?\.focus\(\)/.test(rjs));
  check("renderer: showQuickPrompt resets priority to none (blank value + hidden row)", /function showQuickPrompt\(\)[^]*?quickprompt-prio[^]*?value = ""[^]*?quickprompt-prio-row[^]*?display = "none"/.test(rjs));
  check("renderer: submit reads + clamps the priority (blank → null, else 0–100)", /quickprompt-prio[^]*?\.value\.trim\(\)[^]*?rawPrio === "" \? null : Math\.max\(0, Math\.min\(100/.test(rjs));
  check("renderer: submit threads importance into newSession", /const r = await api\.newSession\("claude", text, importance\)/.test(rjs));
  check("renderer: the focus pin does NOT steal focus from an in-overlay sibling (the prio field)", /quickprompt-overlay"\)\.contains\(document\.activeElement\)\) return;/.test(rjs));

  // --- KEYBOARD-side dismiss/focus fix: when the overlay opens over a focused TERMINAL pane, the
  // `S.panes[S.focused] === "terminal"` early-return used to swallow Esc/Enter (couldn't close or
  // submit), and over a non-terminal pane the master key could re-arm and yank focus out. So overlay
  // keys MUST be dispatched at the TOP of the keydown listener, above both. -------------------------
  check("renderer: an open overlay owns the keyboard via handleOverlayKey", /if \(overlayOpen\(\)\) \{ await handleOverlayKey\(e\); return; \}/.test(rjs));
  check(
    "renderer: overlay keydown is dispatched ABOVE the terminal early-return (Esc/Enter not swallowed)",
    rjs.indexOf("await handleOverlayKey(e)") >= 0 &&
      rjs.indexOf("await handleOverlayKey(e)") < rjs.indexOf('=== "terminal") return;')
  );
  check("renderer: Esc closes the overlay AND restores keyboard focus to the pane", /handleOverlayKey[^]*?e\.key === "Escape"[^]*?closeOverlays\(\);\s*applyKeyboardTarget\(\)/.test(rjs));
  check("renderer: the quick-prompt box re-grabs focus on blur while open (Tab/programmatic focus pin)", /_focusPinned[^]*?addEventListener\("blur"[^]*?quickprompt-overlay[^]*?\.focus\(\)/.test(rjs));

  const html = src("src/renderer/index.html");
  check("html: quickprompt-overlay + textarea exist", /id="quickprompt-overlay"/.test(html) && /id="quickprompt-input"/.test(html));
  check("html: priority field (number input 0–100) lives in the overlay", /id="quickprompt-prio-row"/.test(html) && /id="quickprompt-prio"[^>]*type="number"[^>]*min="0"[^>]*max="100"/.test(html));

  // the optional prompt + importance must thread through every newSession entry point.
  check("preload: newSession forwards prompt + importance", /newSession:\s*\(kind[^)]*prompt[^)]*importance[^)]*\)\s*=>\s*ipcRenderer\.invoke\("newSession", kind, prompt, importance\)/.test(src("src/main/preload.ts")));
  check("main IPC: newSession forwards prompt + importance", /ipcMain\.handle\("newSession",[^]*?newSession\(kind as any, prompt, importance \?\? null\)/.test(src("src/main/main.ts")));
  check("controller: newSession passes prompt into launchTerminalSession", /launchTerminalSession\(\{ kind, repo, skipPermissions: kind === "claude", prompt \}\)/.test(src("src/core/controller.ts")));
  check("controller: newSession writes the launch-time manual importance", /newSession\([^]*?if \(importance != null[^]*?setManualImportance\(this\.db, id/.test(src("src/core/controller.ts")));
  check("server: /api/newSession reads body.prompt + clamps body.importance", /body\.importance[^]*?Math\.max\(0, Math\.min\(100[^]*?ctrl\.newSession\(kind, typeof body\.prompt === "string"[^)]*?, imp\)/.test(src("src/server/server.ts")));
  check("webapi: newSession posts prompt + importance", /newSession:\s*\(kind, prompt, importance\)\s*=>\s*jpost\("\/api\/newSession", \{ kind, prompt, importance \}\)/.test(src("src/server/webapi.js")));

  process.exit(summary());
}

run();
