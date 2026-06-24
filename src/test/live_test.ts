/**
 * Live tests that exercise the real Claude subscription (claude -p) and a real
 * launched session. Gated behind COCKPIT_LIVE=1 because they cost tokens + time.
 *
 *   COCKPIT_LIVE=1 node dist/test/live_test.js
 *
 * Part A: triage Claude-fallback + summarize produce sane output.
 * Part B: launch a REAL Claude Code session in a fresh git worktree, prove it shows
 *         as WORKING (hidden) while running, then becomes surfaced when it stops.
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFileSync } from "child_process";
import { tmpHome, check, summary } from "./helpers";

// NOTE: keep the REAL HOME so the launched `claude` is already configured/trusted
// (a fresh HOME triggers first-run onboarding and the session never proceeds).
// Only the cockpit DB + config are redirected to a throwaway dir.
const HOME = tmpHome();
process.env.COCKPIT_DB = path.join(HOME, "cockpit.db");
process.env.COCKPIT_CONFIG_DIR = path.join(HOME, "config");
fs.mkdirSync(process.env.COCKPIT_CONFIG_DIR, { recursive: true });
fs.copyFileSync(path.resolve(__dirname, "../../config/weights.json"), path.join(process.env.COCKPIT_CONFIG_DIR, "weights.json"));
fs.copyFileSync(path.resolve(__dirname, "../../config/keymap.json"), path.join(process.env.COCKPIT_CONFIG_DIR, "keymap.json"));

import { openDb } from "../core/db";
import { loadConfig } from "../core/config";
import { SessionManager } from "../core/sessions";
import { Engine } from "../core/engine";
import { triage } from "../core/triage";
import { summarize } from "../core/summarize";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();

  console.log("\n== Part A: Claude triage fallback (subscription) ==");
  // Deliberately ambiguous so rules return null and Claude is consulted.
  const t = await triage(
    {
      state: "WAITING_INPUT",
      questionText:
        "I finished the first pass but I'm unsure whether the threshold of 0.5 is right for this dataset given the class imbalance; it might need to be lower. How should I proceed here, considering downstream recall?",
      changedLines: 3,
      cfg: cfg.triage,
    },
    cfg.models.triage
  );
  console.log("  triage ->", JSON.stringify(t));
  check("triage returns a valid category", ["SIMPLE_QUESTION", "REVIEW_DIFF", "COMPLEX_DECISION", "FYI_DONE"].includes(t.category));

  console.log("\n== Part A: summarize a simple question (subscription) ==");
  const sum = await summarize({
    category: "SIMPLE_QUESTION",
    questionText: "Should I bind the health endpoint to port 8080? (yes/no)",
    recentTranscript: "user: set up a health endpoint for the worker\nassistant: Should I bind the health endpoint to port 8080? (yes/no)",
    model: cfg.models.summary,
  });
  console.log("  one_liner:", sum.one_liner);
  console.log("  suggested:", sum.suggested_answer);
  check("summarize produced a one-liner", !!sum.one_liner);
  check("summarize produced a suggested answer", !!sum.suggested_answer);

  const db = openDb();
  const sm = new SessionManager(db);
  const engine = new Engine(db, sm, cfg, { enrich: false });

  let haveTmux = true;
  try {
    execFileSync("bash", ["-lc", "command -v tmux"], { stdio: "ignore" });
  } catch {
    haveTmux = false;
  }

  // Part B1: a real *launched* interactive session must read as WORKING & hidden
  // while it is busy (the CRITICAL RULE on a genuinely running session).
  console.log("\n== Part B1: real launched session reads WORKING & stays hidden ==");
  if (haveTmux) {
    const repo = path.join(HOME, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const g = (a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "init"]);
    const id = sm.launch({
      repo,
      title: "live launch probe",
      prompt: "Count slowly to twenty, one number per line, pausing between each. Take your time.",
    });
    let sawWorkingHidden = false;
    for (let i = 0; i < 6; i++) {
      await engine.tick();
      const s = sm.list().find((x) => x.id === id)!;
      const isSurfaced = engine.queue().some((it) => it.session_id === id);
      console.log(`  t+${i * 3}s state=${s.state} surfaced=${isSurfaced} alive=${sm.processAlive(s)}`);
      if (s.state === "WORKING" && !isSurfaced) sawWorkingHidden = true;
      await sleep(3000);
    }
    check("running launched session is WORKING and hidden", sawWorkingHidden);
    try {
      execFileSync("tmux", ["kill-session", "-t", "cockpit-live-launch-probe"], { stdio: "ignore" });
    } catch {}
  } else {
    console.log("  (tmux unavailable — skipped)");
  }

  // Part B2: a real launched interactive session that asks a question and waits
  // must transition WORKING (hidden) -> WAITING_INPUT (surfaced) on real transcript data.
  console.log("\n== Part B2: real session WORKING(hidden) -> WAITING_INPUT(surfaced) ==");
  if (!haveTmux) {
    console.log("  (tmux unavailable — skipped)");
    process.exit(summary());
  }
  const repo2 = path.join(HOME, "repo2");
  fs.mkdirSync(repo2, { recursive: true });
  const g2 = (a: string[]) => execFileSync("git", a, { cwd: repo2, stdio: "ignore" });
  g2(["init", "-q"]);
  g2(["config", "user.email", "t@t"]);
  g2(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo2, "README.md"), "# demo2\n");
  g2(["add", "-A"]);
  g2(["commit", "-qm", "init"]);

  const id2 = sm.launch({
    repo: repo2,
    title: "ask probe",
    prompt:
      "Ask me exactly one short question on a single line ending in a question mark: which logging level I want, info or debug. Then stop and wait for my answer. Do nothing else, run no tools.",
  });
  let sawWorking2 = false;
  let surfaced2: any = null;
  for (let i = 0; i < 50; i++) {
    await engine.tick();
    const s = sm.list().find((x) => x.id === id2)!;
    const it = engine.queue().find((q) => q.session_id === id2);
    console.log(`  t+${i * 3}s state=${s.state} surfaced=${!!it}`);
    if (s.state === "WORKING" && !it) sawWorking2 = true;
    if (it) {
      surfaced2 = it;
      console.log("  surfaced as", it.category, "->", (it.question || "").replace(/\n/g, " ").slice(0, 120));
      break;
    }
    await sleep(3000);
  }
  check("real ask-session was WORKING and hidden first", sawWorking2);
  check("real ask-session surfaced as WAITING_INPUT", !!surfaced2 && surfaced2.state === "WAITING_INPUT");
  try {
    execFileSync("tmux", ["kill-session", "-t", "cockpit-ask-probe"], { stdio: "ignore" });
  } catch {}

  // Part C: a session BLOCKED ON ITS OWN background job must stay HIDDEN (the WAITING_ON_SELF case,
  // card 288) — it printed a status line and is just waiting for its own work, nothing for the
  // operator. This exercises the Haiku final gate, so it needs the classifier ON (enrich-enabled).
  console.log("\n== Part C: WAITING_ON_SELF (blocked on own script) stays hidden ==");
  const gateEngine = new Engine(db, sm, cfg, { enrich: true, discover: false, pr: false, kanban: false });
  const repo3 = path.join(HOME, "repo3");
  fs.mkdirSync(repo3, { recursive: true });
  const g3 = (a: string[]) => execFileSync("git", a, { cwd: repo3, stdio: "ignore" });
  g3(["init", "-q"]);
  g3(["config", "user.email", "t@t"]);
  g3(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo3, "README.md"), "# demo3\n");
  g3(["add", "-A"]);
  g3(["commit", "-qm", "init"]);
  const id3 = sm.launch({
    repo: repo3,
    title: "self-block probe",
    prompt:
      "Run this exact shell command in the background: `sleep 45 &`. Then print exactly one line: 'Kicked off a 45s background job; waiting for it to finish.' Then STOP and wait — do NOT ask me anything and do NOT run any other tools.",
  });
  let everSurfacedC = false;
  let sawSelfBlockHidden = false;
  for (let i = 0; i < 14; i++) {
    await gateEngine.tick();
    const s = sm.list().find((x) => x.id === id3)!;
    const it = gateEngine.queue().find((q) => q.session_id === id3);
    console.log(`  t+${i * 3}s state=${s.state} surfaced=${!!it} alive=${sm.processAlive(s)}`);
    if (it) everSurfacedC = true;
    if (s.state === "WORKING" && !it) sawSelfBlockHidden = true;
    await sleep(3000);
  }
  check("self-blocked session was kept WORKING & hidden while its job ran", sawSelfBlockHidden);
  check("self-blocked session was NEVER surfaced into Up Next while busy", !everSurfacedC);
  try {
    execFileSync("tmux", ["kill-session", "-t", "cockpit-self-block-probe"], { stdio: "ignore" });
  } catch {}

  process.exit(summary());
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
