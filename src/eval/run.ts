/**
 * Eval / goldset harness — the project's one safety promise made MEASURABLE.
 *
 * Promise: "never surface a session that isn't ready for the operator." Only
 * WAITING_INPUT and DONE are surfaced; WORKING and UNKNOWN must stay hidden. A
 * FALSE SURFACE (a truly-working / ambiguous session predicted as ready) is the
 * worst failure mode, so we measure it directly as the FALSE-SURFACE RATE and
 * gate on it being exactly 0.
 *
 * Cases are DATA (src/eval/goldset/*.json), labelled from the DOCUMENTED contract
 * in stateDetector.ts / triage.ts — not from whatever the code happens to do. Runs
 * fully offline & deterministic: the async LLM triage() is skipped by default; only
 * the pure detectState + triageRules are exercised (set COCKPIT_EVAL_LLM=1 to wire a
 * live fallback later — OFF by default).
 *
 * Run:  npm run eval    (build + run)   |   node dist/eval/run.js
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---- Redirect HOME + DB + config to throwaway locations BEFORE importing core. ----
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-eval-"));
process.env.HOME = HOME;
process.env.COCKPIT_DB = path.join(HOME, "cockpit.db");
process.env.COCKPIT_CONFIG_DIR = path.join(HOME, "config");
fs.mkdirSync(process.env.COCKPIT_CONFIG_DIR, { recursive: true });
fs.copyFileSync(
  path.resolve(__dirname, "../../config/weights.json"),
  path.join(process.env.COCKPIT_CONFIG_DIR, "weights.json")
);
fs.copyFileSync(
  path.resolve(__dirname, "../../config/keymap.json"),
  path.join(process.env.COCKPIT_CONFIG_DIR, "keymap.json")
);

import { SessionState, TriageCategory } from "../core/db";
import { loadConfig } from "../core/config";
import { detectState } from "../core/stateDetector";
import { triageRules } from "../core/triage";
import { parseTranscript } from "../core/transcript";

export interface GoldCase {
  id: string;
  description: string;
  transcript: any[]; // raw transcript line objects (user/assistant turns)
  processAlive: boolean;
  msSinceWrite: number;
  quietPeriodMs: number;
  changedLines: number;
  expected: { state: SessionState; triage?: TriageCategory };
  source: "fixture" | "real";
}

const READY: SessionState[] = ["WAITING_INPUT", "DONE"];
const STATES: SessionState[] = ["WAITING_INPUT", "WORKING", "DONE", "UNKNOWN"];
const isReady = (s: SessionState) => READY.includes(s);

// thresholds the run gates on (besides false-surface == 0)
const MIN_STATE_ACCURACY = 1.0; // our authored seed set should be perfectly labelled
const MIN_TRIAGE_ACCURACY = 1.0;

const C = {
  g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", dim: "\x1b[2m", b: "\x1b[1m", reset: "\x1b[0m",
};

/** Materialize a goldset transcript to a temp .jsonl and parse it like the real app does. */
function viewFor(c: GoldCase, dir: string) {
  const file = path.join(dir, c.id + ".jsonl");
  const lines = c.transcript.map((o) => {
    // stamp a timestamp/cwd like real transcript lines if absent (parse is robust either way).
    const withMeta: any = { timestamp: "2026-06-09T12:00:00.000Z", cwd: dir, ...o };
    return JSON.stringify(withMeta);
  });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return parseTranscript(file);
}

function loadCases(file: string): GoldCase[] {
  const p = path.resolve(__dirname, "../../src/eval/goldset", file);
  return JSON.parse(fs.readFileSync(p, "utf8")) as GoldCase[];
}

function main(): number {
  const cfg = loadConfig();
  const tmpDir = path.join(HOME, "transcripts");
  fs.mkdirSync(tmpDir, { recursive: true });

  const stateCases = loadCases("state.json");
  const triageCases = loadCases("triage.json");
  // every case (state + triage) contributes to STATE accuracy + the safety metric.
  const allCases = [...stateCases, ...triageCases];

  // ---- run the state detector over every case ----
  const confusion: Record<string, Record<string, number>> = {};
  for (const e of STATES) { confusion[e] = {}; for (const p of STATES) confusion[e][p] = 0; }

  let stateCorrect = 0;
  const stateMisses: string[] = [];
  const falseSurfaces: { id: string; expected: SessionState; predicted: SessionState; reason: string }[] = [];

  for (const c of allCases) {
    const view = c.transcript.length ? viewFor(c, tmpDir) : null;
    const { state, reason } = detectState({
      view,
      processAlive: c.processAlive,
      msSinceWrite: c.msSinceWrite,
      quietPeriodMs: c.quietPeriodMs,
    });
    confusion[c.expected.state][state]++;
    if (state === c.expected.state) stateCorrect++;
    else stateMisses.push(`${c.id}: expected ${c.expected.state}, got ${state} (${reason})`);

    // THE SAFETY METRIC: true state is NOT ready, but we predicted ready.
    if (!isReady(c.expected.state) && isReady(state))
      falseSurfaces.push({ id: c.id, expected: c.expected.state, predicted: state, reason });
  }

  const notReadyTotal = allCases.filter((c) => !isReady(c.expected.state)).length;
  const stateAccuracy = stateCorrect / allCases.length;
  const falseSurfaceRate = notReadyTotal ? falseSurfaces.length / notReadyTotal : 0;

  // ---- triage over the cases that declare an expected triage label ----
  let triageCorrect = 0, triageTotal = 0;
  const triageMisses: string[] = [];
  for (const c of [...stateCases, ...triageCases]) {
    if (!c.expected.triage) continue;
    triageTotal++;
    const view = c.transcript.length ? viewFor(c, tmpDir) : null;
    const det = detectState({
      view, processAlive: c.processAlive, msSinceWrite: c.msSinceWrite, quietPeriodMs: c.quietPeriodMs,
    });
    // only ready states reach triage; if the detector didn't mark it ready that's a state miss,
    // counted as a triage miss too (the pipeline would never have triaged it).
    const ctx = { state: det.state, questionText: view?.lastAssistant?.text || "", changedLines: c.changedLines, cfg: cfg.triage };
    const ruled = isReady(det.state) ? triageRules(ctx) : null;
    if (ruled && ruled.category === c.expected.triage) triageCorrect++;
    else triageMisses.push(`${c.id}: expected ${c.expected.triage}, got ${ruled ? ruled.category : "(not-ready/uncertain)"}`);
  }
  const triageAccuracy = triageTotal ? triageCorrect / triageTotal : 1;

  // ---------------------------------- report ----------------------------------
  console.log(`\n${C.b}== ClaudeOS eval / goldset ==${C.reset}`);
  console.log(`${C.dim}cases: ${allCases.length} state · ${triageTotal} triage${C.reset}\n`);

  console.log(`${C.b}State confusion matrix${C.reset}  ${C.dim}(rows = expected, cols = predicted)${C.reset}`);
  const pad = (s: string, n: number) => s.padEnd(n);
  const header = pad("expected \\ pred", 16) + STATES.map((s) => pad(s, 14)).join("");
  console.log("  " + C.dim + header + C.reset);
  for (const e of STATES) {
    const row = STATES.map((p) => {
      const n = confusion[e][p];
      if (n === 0) return pad("·", 14);
      const onDiag = e === p;
      const surfaceErr = !isReady(e) && isReady(p);
      const col = onDiag ? C.g : surfaceErr ? C.r : C.y;
      return col + pad(String(n), 14) + C.reset;
    }).join("");
    console.log("  " + pad(e, 16) + row);
  }

  console.log(`\n${C.b}Overall state accuracy:${C.reset} ${(stateAccuracy * 100).toFixed(1)}%  (${stateCorrect}/${allCases.length})`);
  if (stateMisses.length) {
    console.log(`${C.y}  state mismatches:${C.reset}`);
    for (const m of stateMisses) console.log("    - " + m);
  }

  // THE headline number.
  const fsColor = falseSurfaces.length === 0 ? C.g : C.r;
  console.log(`\n${C.b}FALSE-SURFACE RATE (the hard rule):${C.reset} ${fsColor}${(falseSurfaceRate * 100).toFixed(2)}%  (${falseSurfaces.length}/${notReadyTotal} not-ready cases wrongly surfaced)${C.reset}`);
  if (falseSurfaces.length) {
    console.log(`${C.r}${C.b}  !!! SAFETY VIOLATION — these working/ambiguous sessions were marked READY:${C.reset}`);
    for (const f of falseSurfaces)
      console.log(`${C.r}    - ${f.id}: true=${f.expected} predicted=${f.predicted} — ${f.reason}${C.reset}`);
  } else {
    console.log(`${C.g}  ✓ no working/ambiguous session was ever surfaced.${C.reset}`);
  }

  console.log(`\n${C.b}Triage accuracy:${C.reset} ${(triageAccuracy * 100).toFixed(1)}%  (${triageCorrect}/${triageTotal})`);
  if (triageMisses.length) {
    console.log(`${C.y}  triage mismatches:${C.reset}`);
    for (const m of triageMisses) console.log("    - " + m);
  }

  // ---- persist latest result (tracked, so regressions show in diffs) ----
  const result = {
    timestamp: new Date().toISOString(),
    cases: { state: allCases.length, triage: triageTotal },
    state_accuracy: Number(stateAccuracy.toFixed(4)),
    triage_accuracy: Number(triageAccuracy.toFixed(4)),
    false_surface_rate: Number(falseSurfaceRate.toFixed(4)),
    false_surfaces: falseSurfaces,
    state_misses: stateMisses,
    triage_misses: triageMisses,
    confusion,
  };
  const resDir = path.resolve(__dirname, "../../src/eval/results");
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, "latest.json"), JSON.stringify(result, null, 2) + "\n");

  // ---- gate ----
  const accOk = stateAccuracy >= MIN_STATE_ACCURACY;
  const triOk = triageAccuracy >= MIN_TRIAGE_ACCURACY;
  const safeOk = falseSurfaces.length === 0;
  const ok = accOk && triOk && safeOk;

  console.log(
    `\n${ok ? C.g + C.b + "  EVAL GREEN" : C.r + C.b + "  EVAL RED"}${C.reset}  ` +
    `state ${(stateAccuracy * 100).toFixed(1)}% · triage ${(triageAccuracy * 100).toFixed(1)}% · false-surface ${(falseSurfaceRate * 100).toFixed(2)}%` +
    `${ok ? "" : `  (${[!safeOk && "false-surface>0", !accOk && "state<thresh", !triOk && "triage<thresh"].filter(Boolean).join(", ")})`}\n`
  );
  return ok ? 0 : 1;
}

process.exit(main());
