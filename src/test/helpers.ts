/** Test helpers: synthetic Claude Code transcripts + a tiny assertion harness. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { projectDirFor } from "../core/transcript";

// ⚠️ CRITICAL SAFETY: purge inherited GIT_* env vars at test startup. The test suite spawns real
// `git` for throwaway repos (makeRepoWithDiff / buildDemoPrRepo). If the suite runs inside a GIT
// HOOK (our pre-commit/pre-push gate), git exports GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE into the
// environment — and those OVERRIDE `cwd`, so a test's `git add -A && git commit` would operate on
// the REAL repo (it once committed a temp dir's lone file.txt to master, deleting everything).
// helpers.ts is imported by every test entrypoint, so clearing it here protects the whole suite
// (and any server subprocess it spawns, which inherits this sanitized env).
for (const k of Object.keys(process.env)) {
  if (/^GIT_/.test(k) && k !== "GIT_SSH" && k !== "GIT_SSH_COMMAND") delete process.env[k];
}

export interface TLine {
  role: "assistant" | "user";
  text?: string;
  toolUse?: boolean;
  toolResult?: boolean;
  toolName?: string; // tool_use name (default Bash)
  toolId?: string; // tool_use id / tool_result tool_use_id (default t1)
  stop_reason?: string | null;
}

let TS = Date.parse("2026-06-06T12:00:00.000Z");
function nextTs(): string {
  TS += 1000;
  return new Date(TS).toISOString();
}

/** Write a synthetic transcript for `cwd` under the (temp) HOME's projects dir. */
export function writeTranscript(cwd: string, lines: TLine[]): string {
  const dir = projectDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.jsonl");
  const out: string[] = [];
  // a couple of bookkeeping lines like real transcripts
  out.push(JSON.stringify({ type: "mode", timestamp: nextTs() }));
  for (const l of lines) {
    const content: any[] = [];
    if (l.toolUse) content.push({ type: "tool_use", id: l.toolId || "t1", name: l.toolName || "Bash", input: {} });
    else if (l.toolResult) content.push({ type: "tool_result", tool_use_id: l.toolId || "t1", content: l.text || "ok" });
    else content.push({ type: "text", text: l.text || "" });
    out.push(
      JSON.stringify({
        type: l.role,
        timestamp: nextTs(),
        cwd,
        message: {
          role: l.role,
          stop_reason: l.role === "assistant" ? l.stop_reason ?? "end_turn" : null,
          content,
        },
      })
    );
  }
  fs.writeFileSync(file, out.join("\n") + "\n");
  // backdate mtime so the recency rule doesn't fire for mock (no live process anyway)
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  return file;
}

/** Create a throwaway git repo with `changedLines` of uncommitted change for diff tests.
 *  Idempotent: if the repo already exists (e.g. a prior demo run), it only refreshes the
 *  uncommitted change rather than re-initialising/re-committing the base. */
export function makeRepoWithDiff(root: string, changedLines: number): string {
  fs.mkdirSync(root, { recursive: true });
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const f = path.join(root, "file.txt");
  if (!fs.existsSync(path.join(root, ".git"))) {
    g(["init", "-q"]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    fs.writeFileSync(f, Array.from({ length: 5 }, (_, i) => `base${i}`).join("\n") + "\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "base"]);
  }
  // Always (re)write the working-tree change so there is a live diff vs HEAD.
  fs.writeFileSync(f, Array.from({ length: 5 + changedLines }, (_, i) => `changed${i}`).join("\n") + "\n");
  return root;
}

export function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-test-"));
  return d;
}

// --- tiny assert harness ---
let pass = 0;
let fail = 0;
const failures: string[] = [];
export function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗ ${name}${detail ? " — " + detail : ""}\x1b[0m`);
  }
}
export function eq(name: string, actual: any, expected: any): void {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
export function summary(): number {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("FAILURES:\n - " + failures.join("\n - "));
  return fail === 0 ? 0 : 1;
}
