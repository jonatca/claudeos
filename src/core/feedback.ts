/**
 * Feedback learning loop (jarvis Phase 5). One-keystroke feedback on any suggestion
 * mutates two small, inspectable stores:
 *
 *   signal_adjustments  - a running nudge added to an item's score at rank time,
 *                         keyed by category (e.g. 'category:REVIEW_DIFF') and by the
 *                         dominant signal. This is the "small local model": per-signal
 *                         weight nudging, the simplest thing that genuinely learns.
 *
 *   view_pref           - per-category preference for raw-output vs summary, and for
 *                         more-vs-less context, so the classifier's DEFAULT VIEW adapts.
 *
 * Everything is a transparent counter + bounded nudge; nothing is a black box.
 */
import { DatabaseSync } from "node:sqlite";
import { TriageCategory } from "./db";

export type Feedback =
  | "priority_high" // ranked too high -> push category down
  | "priority_low" // ranked too low -> push category up
  | "wrong" // wrong classification / suggestion -> down + view reset
  | "too_much_output" // didn't need full output -> prefer summary view
  | "need_more_context" // needed more context -> prefer richer context
  | "good"; // good suggestion -> small up

const NUDGE = 5; // points per feedback event, bounded below
const CLAMP = 40;

export interface AdjustmentRow {
  key: string;
  adjustment: number;
  up_count: number;
  down_count: number;
}

function bump(db: DatabaseSync, key: string, delta: number): void {
  db.prepare(
    `INSERT INTO signal_adjustments (key, adjustment, up_count, down_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       adjustment = MAX(-${CLAMP}, MIN(${CLAMP}, adjustment + ?)),
       up_count = up_count + ?,
       down_count = down_count + ?,
       updated_at = datetime('now')`
  ).run(
    key,
    Math.max(-CLAMP, Math.min(CLAMP, delta)),
    delta > 0 ? 1 : 0,
    delta < 0 ? 1 : 0,
    delta,
    delta > 0 ? 1 : 0,
    delta < 0 ? 1 : 0
  );
}

function bumpView(db: DatabaseSync, category: TriageCategory, rawDelta: number, ctxDelta: number): void {
  db.prepare(
    `INSERT INTO view_pref (category, raw_pref, context_pref)
     VALUES (?, ?, ?)
     ON CONFLICT(category) DO UPDATE SET
       raw_pref = raw_pref + ?,
       context_pref = context_pref + ?,
       updated_at = datetime('now')`
  ).run(category, rawDelta, ctxDelta, rawDelta, ctxDelta);
}

export function applyFeedback(
  db: DatabaseSync,
  args: { itemId: number; sessionId: number; category: TriageCategory | null; state: string; feedback: Feedback }
): void {
  const { itemId, sessionId, category, state, feedback } = args;
  db.prepare(
    `INSERT INTO decision_log (item_id, session_id, category, state, feedback) VALUES (?,?,?,?,?)`
  ).run(itemId, sessionId, category ?? null, state, feedback);

  const catKey = category ? `category:${category}` : null;
  switch (feedback) {
    case "priority_high":
      if (catKey) bump(db, catKey, -NUDGE);
      break;
    case "priority_low":
      if (catKey) bump(db, catKey, +NUDGE);
      break;
    case "good":
      if (catKey) bump(db, catKey, +Math.round(NUDGE / 2));
      break;
    case "wrong":
      if (catKey) bump(db, catKey, -NUDGE);
      if (category) bumpView(db, category, +1, 0); // reconsider: lean toward raw next time
      break;
    case "too_much_output":
      if (category) bumpView(db, category, -1, 0); // prefer summary
      break;
    case "need_more_context":
      if (category) bumpView(db, category, 0, +1); // prefer richer context
      break;
  }
}

/** Learned score nudges for an item, keyed by its category. */
export function learnedAdjustments(
  db: DatabaseSync,
  category: TriageCategory | null
): { key: string; adjustment: number }[] {
  if (!category) return [];
  const r = db
    .prepare("SELECT key, adjustment FROM signal_adjustments WHERE key = ?")
    .get(`category:${category}`) as { key: string; adjustment: number } | undefined;
  return r ? [{ key: r.key, adjustment: r.adjustment }] : [];
}

export interface ViewPref {
  preferRaw: boolean;
  preferMoreContext: boolean;
  raw_pref: number;
  context_pref: number;
}

/** Whether, by learned preference, this category should default to raw / richer context. */
export function viewPreference(db: DatabaseSync, category: TriageCategory | null): ViewPref {
  const def = { preferRaw: false, preferMoreContext: false, raw_pref: 0, context_pref: 0 };
  if (!category) return def;
  const r = db
    .prepare("SELECT raw_pref, context_pref FROM view_pref WHERE category = ?")
    .get(category) as { raw_pref: number; context_pref: number } | undefined;
  if (!r) return def;
  return {
    preferRaw: r.raw_pref >= 2,
    preferMoreContext: r.context_pref >= 2,
    raw_pref: r.raw_pref,
    context_pref: r.context_pref,
  };
}

export function allAdjustments(db: DatabaseSync): AdjustmentRow[] {
  return db
    .prepare("SELECT key, adjustment, up_count, down_count FROM signal_adjustments ORDER BY ABS(adjustment) DESC")
    .all() as unknown as AdjustmentRow[];
}

export function recentDecisions(db: DatabaseSync, limit = 15): any[] {
  return db
    .prepare("SELECT * FROM decision_log ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as any[];
}
