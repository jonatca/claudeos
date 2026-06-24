/**
 * Answer-quality feedback — the "draft comparison" loop (inspired by the example project's
 * draft-comparisons.js). When the operator answers a session, ClaudeOS already had a
 * SUGGESTED answer (and often A/B/C/D options). We save the suggestion next to what the
 * operator ACTUALLY sent, classify the gap, and record which option (if any) was chosen.
 *
 * Why a separate store from decision_log / signal_adjustments:
 *   - decision_log + signal_adjustments learn PRIORITIZATION (which task to show first).
 *     That is the operator's #1 concern and must not be perturbed by answer wording.
 *   - answer_feedback learns SUGGESTION QUALITY (what to draft) and feeds the eval goldset
 *     with confirmed question->answer pairs. Strictly additive; reads, never writes, ranking.
 *
 * Everything here is transparent: raw text in, a small edit-distance, a readable outcome.
 */
import { DatabaseSync } from "node:sqlite";
import { TriageCategory } from "./db";

export type AnswerOutcome =
  | "accepted" // operator sent the suggestion verbatim
  | "option_picked" // operator picked a different offered option (B/C/D) unedited
  | "edited" // operator tweaked the suggestion (stayed close)
  | "rewritten" // operator threw the suggestion away and wrote their own
  | "empty"; // nothing meaningful sent (ack / skip)

export interface AnswerCapture {
  itemId: number;
  sessionId: number;
  category: TriageCategory | null;
  state: string;
  question: string;
  suggested: string; // option A / the headline suggestion
  options: string[]; // all offered candidates, in A/B/C/D order (options[0] is usually `suggested`)
  final: string; // what the operator actually sent
}

export interface AnswerClassification {
  outcome: AnswerOutcome;
  chosenIndex: number; // index in options matching `final`, else -1
  editDistance: number; // Levenshtein(suggested, final)
  similarity: number; // 0..1 vs the suggestion
}

const norm = (s: string): string => (s || "").replace(/\s+/g, " ").trim();
// Answers are short; cap to keep the O(n*m) DP cheap and bounded even on a pasted essay.
const CAP = 4000;
const EDIT_CLOSE = 0.6; // similarity >= this counts as an edit of the suggestion, not a rewrite

/** Classic Levenshtein, length-capped. Returns edit distance in characters. */
export function levenshtein(a: string, b: string): number {
  a = a.slice(0, CAP);
  b = b.slice(0, CAP);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 = identical, 0 = completely different (normalized similarity from edit distance). */
export function similarity(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na && !nb) return 1;
  const maxLen = Math.max(na.length, nb.length) || 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

/** Decide what the operator did, relative to the suggestion + the offered options. */
export function classifyAnswer(suggested: string, options: string[], final: string): AnswerClassification {
  const nf = norm(final);
  const ns = norm(suggested);
  const editDistance = levenshtein(ns, nf);
  const sim = similarity(ns, nf);
  // Which offered option (if any) did they send unchanged? Prefer the earliest match.
  const chosenIndex = options.findIndex((o) => norm(o) === nf);

  let outcome: AnswerOutcome;
  if (!nf) outcome = "empty";
  else if (ns && nf === ns) outcome = "accepted";
  else if (chosenIndex >= 0) outcome = "option_picked"; // an offered B/C/D, sent verbatim
  else if (sim >= EDIT_CLOSE) outcome = "edited";
  else outcome = "rewritten";

  return { outcome, chosenIndex, editDistance, similarity: Number(sim.toFixed(3)) };
}

/**
 * Persist one answer event. Returns the inserted row id (for the undo stack), or 0 if
 * there was nothing worth recording (no suggestion AND no options — nothing to compare).
 */
export function recordAnswer(db: DatabaseSync, cap: AnswerCapture): number {
  const options = (cap.options || []).filter((o) => typeof o === "string");
  const suggested = cap.suggested || options[0] || "";
  // Nothing to learn from if we never proposed anything.
  if (!norm(suggested) && options.length === 0) return 0;

  const c = classifyAnswer(suggested, options.length ? options : [suggested], cap.final || "");
  const r = db
    .prepare(
      `INSERT INTO answer_feedback
         (item_id, session_id, category, state, question, suggested, final, options_json,
          chosen_index, edit_distance, similarity, outcome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      cap.itemId,
      cap.sessionId,
      cap.category ?? null,
      cap.state ?? null,
      norm(cap.question).slice(0, CAP),
      suggested.slice(0, CAP),
      (cap.final || "").slice(0, CAP),
      JSON.stringify(options.slice(0, 8)),
      c.chosenIndex,
      c.editDistance,
      c.similarity,
      c.outcome
    );
  return Number(r.lastInsertRowid);
}

export interface AnswerRow {
  id: number;
  item_id: number;
  session_id: number;
  category: string | null;
  state: string | null;
  question: string;
  suggested: string;
  final: string;
  options_json: string | null;
  chosen_index: number;
  edit_distance: number;
  similarity: number;
  outcome: AnswerOutcome;
  created_at: string;
}

export function recentAnswers(db: DatabaseSync, limit = 50): AnswerRow[] {
  return db
    .prepare("SELECT * FROM answer_feedback ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as AnswerRow[];
}

export interface AnswerStats {
  total: number;
  accepted: number;
  optionPicked: number;
  edited: number;
  rewritten: number;
  empty: number;
  acceptanceRate: number; // (accepted + option_picked) / non-empty
  meanSimilarity: number; // over non-empty
  optionHistogram: number[]; // how often slot A/B/C/D... was the chosen one
  byCategory: Record<string, { total: number; acceptanceRate: number }>;
}

/** Interpretable rollup of answer quality — used by the nightly dream + a future panel. */
export function answerStats(db: DatabaseSync, sinceDays = 30): AnswerStats {
  const rows = db
    .prepare(
      `SELECT category, chosen_index, similarity, outcome
         FROM answer_feedback
        WHERE created_at >= datetime('now', ?)`
    )
    .all(`-${Math.max(1, sinceDays)} days`) as unknown as Pick<
    AnswerRow,
    "category" | "chosen_index" | "similarity" | "outcome"
  >[];

  const st: AnswerStats = {
    total: rows.length,
    accepted: 0,
    optionPicked: 0,
    edited: 0,
    rewritten: 0,
    empty: 0,
    acceptanceRate: 0,
    meanSimilarity: 0,
    optionHistogram: [],
    byCategory: {},
  };
  let nonEmpty = 0;
  let simSum = 0;
  for (const r of rows) {
    switch (r.outcome) {
      case "accepted": st.accepted++; break;
      case "option_picked": st.optionPicked++; break;
      case "edited": st.edited++; break;
      case "rewritten": st.rewritten++; break;
      case "empty": st.empty++; break;
    }
    if (r.outcome !== "empty") {
      nonEmpty++;
      simSum += r.similarity || 0;
      if (r.chosen_index >= 0) {
        while (st.optionHistogram.length <= r.chosen_index) st.optionHistogram.push(0);
        st.optionHistogram[r.chosen_index]++;
      }
      const cat = r.category || "(none)";
      const bc = (st.byCategory[cat] ||= { total: 0, acceptanceRate: 0 });
      bc.total++;
      if (r.outcome === "accepted" || r.outcome === "option_picked") bc.acceptanceRate++;
    }
  }
  st.acceptanceRate = nonEmpty ? Number(((st.accepted + st.optionPicked) / nonEmpty).toFixed(3)) : 0;
  st.meanSimilarity = nonEmpty ? Number((simSum / nonEmpty).toFixed(3)) : 0;
  for (const cat of Object.keys(st.byCategory)) {
    const bc = st.byCategory[cat];
    bc.acceptanceRate = bc.total ? Number((bc.acceptanceRate / bc.total).toFixed(3)) : 0;
  }
  return st;
}
