/**
 * Answer-feedback loop test (the "draft comparison" / suggested-vs-corrected store).
 * Verifies: edit-distance classification, that records persist with the right outcome +
 * chosen option, that answerStats rolls up correctly, that dreamAnswers writes a readable
 * dream_log line, and that the delAnswerFeedback undo op reverses a capture.
 *
 * Standalone ring (not part of the heavy harness). Run: node dist/test/answer_feedback_test.js
 */
import * as path from "path";
import * as fs from "fs";
import { tmpHome, check, eq, summary } from "./helpers";

// Throwaway HOME/DB/config BEFORE importing core (same discipline as harness.ts).
const HOME = tmpHome();
process.env.HOME = HOME;
process.env.COCKPIT_DB = path.join(HOME, "cockpit.db");
process.env.COCKPIT_CONFIG_DIR = path.join(HOME, "config");
fs.mkdirSync(process.env.COCKPIT_CONFIG_DIR, { recursive: true });
for (const f of ["weights.json", "keymap.json"]) {
  fs.copyFileSync(path.resolve(__dirname, "../../config/" + f), path.join(process.env.COCKPIT_CONFIG_DIR, f));
}

import { openDb } from "../core/db";
import { classifyAnswer, levenshtein, similarity, recordAnswer, answerStats, recentAnswers } from "../core/answerLog";
import { dreamAnswers } from "../core/dream";
import { lastDreams } from "../core/dream";
import { pushUndo, undo } from "../core/undo";

function main() {
  console.log("\n== answer-feedback loop ==");

  // --- pure: edit distance + similarity ---
  eq("levenshtein kitten/sitting", levenshtein("kitten", "sitting"), 3);
  eq("levenshtein identical", levenshtein("abc", "abc"), 0);
  check("similarity identical = 1", similarity("hello world", "hello world") === 1);
  check("similarity disjoint < 0.3", similarity("yes do it", "absolutely not, cancel everything") < 0.3);

  // --- classify: the four meaningful outcomes ---
  const opts = ["Yes, ship it.", "No, hold off.", "Let me check the logs first."];
  eq("accepted (verbatim suggestion)", classifyAnswer(opts[0], opts, "Yes, ship it.").outcome, "accepted");
  const picked = classifyAnswer(opts[0], opts, "No, hold off.");
  eq("option_picked outcome", picked.outcome, "option_picked");
  eq("option_picked index", picked.chosenIndex, 1);
  eq("edited (small tweak)", classifyAnswer("Yes, ship it.", opts, "Yes, ship it now.").outcome, "edited");
  eq("rewritten (own answer)", classifyAnswer(opts[0], opts, "Actually revert the whole migration and ping me.").outcome, "rewritten");
  eq("empty", classifyAnswer(opts[0], opts, "   ").outcome, "empty");

  const db = openDb();

  // --- record: persists with the right shape ---
  const id1 = recordAnswer(db, { itemId: 1, sessionId: 1, category: "SIMPLE_QUESTION", state: "WAITING_INPUT", question: "Ship it?", suggested: opts[0], options: opts, final: "Yes, ship it." });
  check("recordAnswer returns an id", id1 > 0);
  recordAnswer(db, { itemId: 2, sessionId: 1, category: "SIMPLE_QUESTION", state: "WAITING_INPUT", question: "Ship it?", suggested: opts[0], options: opts, final: "No, hold off." });
  recordAnswer(db, { itemId: 3, sessionId: 2, category: "COMPLEX_DECISION", state: "WAITING_INPUT", question: "Which approach?", suggested: "Use approach A.", options: ["Use approach A.", "Use approach B."], final: "Neither — let's redesign the schema entirely and revisit tomorrow." });
  // No suggestion AND no options -> nothing to learn, not recorded.
  eq("no-suggestion is skipped", recordAnswer(db, { itemId: 4, sessionId: 2, category: null, state: "WAITING_INPUT", question: "?", suggested: "", options: [], final: "whatever" }), 0);

  const rows = recentAnswers(db, 10);
  eq("3 rows recorded", rows.length, 3);
  const r1 = rows.find((r) => r.item_id === 1)!;
  eq("row1 outcome accepted", r1.outcome, "accepted");
  eq("row1 similarity 1", r1.similarity, 1);

  // --- stats rollup ---
  const st = answerStats(db, 365);
  eq("stats total", st.total, 3);
  eq("stats accepted", st.accepted, 1);
  eq("stats optionPicked", st.optionPicked, 1);
  eq("stats rewritten", st.rewritten, 1);
  // acceptanceRate = (accepted + option_picked) / non-empty = 2/3
  check("acceptanceRate ~0.667", Math.abs(st.acceptanceRate - 0.667) < 0.01, `got ${st.acceptanceRate}`);
  check("optionHistogram slot A counted", (st.optionHistogram[0] || 0) >= 1);
  check("byCategory has SIMPLE_QUESTION", !!st.byCategory["SIMPLE_QUESTION"]);

  // --- dream reflection writes a readable line (and does NOT touch ranking nudges) ---
  const before = db.prepare("SELECT COUNT(*) AS n FROM signal_adjustments").get() as { n: number };
  const d = dreamAnswers(db);
  check("dreamAnswers summary mentions answers", /answers:/.test(d.summary), d.summary);
  check("dream_log got the line", lastDreams(db, 1)[0]?.summary === d.summary);
  const after = db.prepare("SELECT COUNT(*) AS n FROM signal_adjustments").get() as { n: number };
  eq("answer dream did NOT add ranking nudges", after.n, before.n);

  // --- undo op reverses a capture ---
  const idU = recordAnswer(db, { itemId: 9, sessionId: 9, category: null, state: "DONE", question: "done?", suggested: "ok", options: ["ok"], final: "ok" });
  check("captured row exists", !!db.prepare("SELECT id FROM answer_feedback WHERE id=?").get(idU));
  pushUndo(db, "sendAnswer", "test", [{ t: "delAnswerFeedback", id: idU }]);
  undo(db);
  check("delAnswerFeedback undo removed the row", !db.prepare("SELECT id FROM answer_feedback WHERE id=?").get(idU));

  process.exit(summary());
}

main();
