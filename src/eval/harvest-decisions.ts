/**
 * Harvest goldset candidates from REAL answer feedback (answer_feedback table).
 *
 * Every time the operator answers a session, controller.sendAnswer records what ClaudeOS
 * SUGGESTED and what the operator actually SENT (see core/answerLog.ts). Those rows are
 * gold: the question text is a real WAITING_INPUT case, its category is a real triage
 * label, and the operator's final text is the confirmed correct answer. This script turns
 * them into CANDIDATE goldset cases for review — the same untrusted-until-confirmed
 * discipline as sample-real.ts.
 *
 * Run:  npm run eval:harvest   (build + run)   |   node dist/eval/harvest-decisions.js
 *
 * Output: src/eval/goldset/from-decisions.json (candidates; a human sets reviewed:true
 * and moves the good ones into triage.json / a future answers goldset).
 */
import * as fs from "fs";
import * as path from "path";
import { openDb } from "../core/db";
import { recentAnswers, AnswerRow } from "../core/answerLog";

interface Candidate {
  id: string;
  description: string;
  question: string;
  state: string | null;
  // The operator endorsed this answer (accepted/option_picked = strong; edited = medium;
  // rewritten = the suggestion was wrong, `final` is the correction).
  suggested: string;
  correct_answer: string;
  outcome: string;
  proposed: { state: string | null; triage: string | null };
  expected: null; // human confirms before it counts
  source: "decision";
  reviewed: false;
}

function main() {
  const db = openDb();
  let rows: AnswerRow[] = [];
  try {
    rows = recentAnswers(db, 500);
  } catch {
    console.log("No answer_feedback table yet — answer some sessions first, then re-run.");
    write({ generated: new Date().toISOString(), harvested: 0, candidates: [] });
    return;
  }

  // Only rows where there is a real question AND a real answer worth learning from.
  const useful = rows.filter((r) => (r.question || "").trim() && (r.final || "").trim() && r.outcome !== "empty");

  const candidates: Candidate[] = useful.map((r) => ({
    id: "dec-" + r.id,
    description: (r.question || "").replace(/\s+/g, " ").slice(0, 120),
    question: r.question || "",
    state: r.state,
    suggested: r.suggested || "",
    correct_answer: r.final || "",
    outcome: r.outcome,
    proposed: { state: r.state, triage: r.category },
    expected: null,
    source: "decision",
    reviewed: false,
  }));

  const byOutcome: Record<string, number> = {};
  for (const r of useful) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

  write({
    generated: new Date().toISOString(),
    note: "CANDIDATES ONLY — harvested from real operator answers (answer_feedback). `correct_answer` is what the operator actually sent; `suggested` is what ClaudeOS proposed. A human sets `expected` + `reviewed:true` before promoting into the goldset.",
    harvested: candidates.length,
    by_outcome: byOutcome,
    candidates,
  });

  console.log(`Harvested ${candidates.length} candidate(s) from answer_feedback.`);
  console.log("By outcome:", JSON.stringify(byOutcome));
  console.log(`Wrote -> ${outPath()}  (UNREVIEWED — confirm before promoting)`);
}

function outPath(): string {
  return path.resolve(__dirname, "../../src/eval/goldset/from-decisions.json");
}
function write(payload: any): void {
  fs.writeFileSync(outPath(), JSON.stringify(payload, null, 2) + "\n");
}

main();
