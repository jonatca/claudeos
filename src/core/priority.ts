/**
 * Priority engine — fully transparent, interpretable scoring.
 *
 * score = Σ (weight_i × signal_i)  +  learned_adjustment(category)
 *
 * EXCEPTION: an operator manual score is ABSOLUTE — score = manualImportance, with only other
 * explicit operator gestures (h/l nudge, snooze, pin) applied on top. No organic/learned terms.
 *
 * Every term is returned in `breakdown` so the UI can show EXACTLY why an item is
 * ranked #1 and how the operator's feedback (learned adjustments) moved it.
 * Signals are normalised to [0,1] so weights in config are directly comparable.
 */
import { Weights } from "./config";
import { ItemRow, SessionRow, TriageCategory } from "./db";

export interface ScoreTerm {
  signal: string;
  raw: number; // normalised signal value [0,1]
  weight: number;
  contribution: number; // weight × raw
  note: string;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreTerm[];
  learned: { key: string; adjustment: number }[];
}

/** Pinned items are forced near the top; this base keeps them above any organic score. */
export const PIN_BASE = 100000;
/** FIX L: how far the just-opened ("active") task sits ABOVE the current highest organic item —
 *  small, so its displayed priority reads like a normal number (e.g. 63 when next is 58) rather
 *  than a flat 50k. The reposition happens at queue() time (it needs the others' scores). */
export const ACTIVE_OVER = 5;

export interface ScoreInputs {
  weights: Weights;
  importance: number; // LLM importance 0..100, or -1 if not yet judged
  manualImportance?: number | null; // operator override 0..100 (replaces LLM importance)
  pinned?: boolean; // force to (near) top of queue
  blocksOtherWork: boolean;
  changedLines: number;
  ageHours: number; // staleness
  focusMatch: number; // 0..1 how well it matches operator's current focus
  deadline: string | null; // ISO; closeness -> urgency
  state: ItemRow["state"];
  category: TriageCategory | null;
  /** learned per-key adjustments, already summed by caller for this item. */
  learnedTerms: { key: string; adjustment: number }[];
  /** <=0 penalty from snoozing — sinks the item while keeping it visible. This is the FULL
   *  (stored) penalty; the contribution applied is the time-decayed effective value (see
   *  effectiveSnoozePenalty): linear recovery to 0 over snoozeRecoverHours from snoozedAt. */
  snoozePenalty?: number;
  /** ISO timestamp of the last snooze — the decay clock's start. No stamp = fully recovered. */
  snoozedAt?: string | null;
  /** Hours for the penalty to decay linearly back to 0 (default 5). */
  snoozeRecoverHours?: number;
  /** FIX BB: PER-ITEM priority offset from h/l (rank higher/lower) — moves ONLY this item, no
   *  global reshuffle. +N = higher, −N = lower. */
  manualPriorityDelta?: number;
  /** FIX L: the operator just opened this session's terminal → boost it to the top. */
  active?: boolean;
  now?: number;
}

function effortSmallSignal(changedLines: number): number {
  // smaller change => closer to 1 (faster to clear). 0 lines -> 1, >=400 -> 0.
  if (changedLines <= 0) return 1;
  return Math.max(0, 1 - Math.min(changedLines, 400) / 400);
}

function stalenessSignal(ageHours: number): number {
  // saturating: 0h -> 0, 24h -> ~1
  return Math.max(0, Math.min(1, ageHours / 24));
}

function deadlineSignal(deadline: string | null, now: number): number {
  if (!deadline) return 0;
  const dl = Date.parse(deadline);
  if (isNaN(dl)) return 0;
  const hoursLeft = (dl - now) / 3.6e6;
  if (hoursLeft <= 0) return 1; // overdue = max urgency
  if (hoursLeft >= 72) return 0; // far away
  return 1 - hoursLeft / 72;
}

export function scoreItem(inp: ScoreInputs): ScoreResult {
  const now = inp.now ?? Date.now();
  const w = inp.weights;
  const terms: ScoreTerm[] = [];

  const add = (signal: string, raw: number, weight: number, note: string) =>
    terms.push({ signal, raw, weight, contribution: +(raw * weight).toFixed(2), note });

  // Importance: an operator manual score (if set) IS the priority score — an absolute override,
  // not a weighted term. The operator typed a number; the queue must show that number, not
  // number/100 × weight buried under organic signals and learned adjustments (the old behaviour
  // made "set to 100" still rank at -38). Organic signals and learned terms are skipped; only
  // other EXPLICIT operator gestures still apply on top: h/l nudges, snooze, pin.
  const manualOverride = inp.manualImportance != null && inp.manualImportance >= 0;
  if (manualOverride) {
    const v = inp.manualImportance!;
    terms.push({ signal: "manual_importance", raw: 1, weight: v, contribution: v, note: `operator set score ${v} — used directly as the priority score (organic signals off)` });
  } else {
    if (inp.importance >= 0)
      add("llm_importance", inp.importance / 100, w.llm_importance, `model judged importance ${inp.importance}/100`);

    add("blocks_other_work", inp.blocksOtherWork ? 1 : 0, w.blocks_other_work, inp.blocksOtherWork ? "operator flagged as blocking" : "not flagged as blocking");
    add("effort_small", effortSmallSignal(inp.changedLines), w.effort_small, `${inp.changedLines} changed lines (smaller = clears faster)`);
    add("staleness", stalenessSignal(inp.ageHours), w.staleness, `${inp.ageHours.toFixed(1)}h old`);
    add("focus_match", inp.focusMatch, w.focus_match, inp.focusMatch > 0 ? "matches your current focus" : "no focus match");
    add("deadline", deadlineSignal(inp.deadline, now), w.deadline, inp.deadline ? `deadline ${inp.deadline}` : "no deadline");

    // State bonuses: needs-input is more actionable than a passive done FYI. FIX W: idle/UNKNOWN
    // sessions are surfaced too but sit at the BOTTOM (reachable, not cluttering the top) via a
    // negative idle base — so the order is WAITING_INPUT > DONE > idle.
    if (inp.state === "WAITING_INPUT") add("needs_input_bonus", 1, w.needs_input_bonus, "session is blocked on your input");
    else if (inp.state === "DONE") add("done_bonus", 1, w.done_bonus, "session finished (informational)");
    else if (inp.state === "UNKNOWN") add("idle_base", 1, (w as any).idle_base ?? -8, "idle session (surfaced low — Complete to remove)");
  }

  // FIX BB: per-item h/l offset — a DIRECT, local priority bump that moves ONLY this task (no
  // weight-vector change → nothing else reshuffles). The generalizing learning is the nightly dream.
  if (inp.manualPriorityDelta) {
    const d = inp.manualPriorityDelta;
    terms.push({ signal: "manual_priority", raw: 1, weight: d, contribution: d, note: `operator ${d > 0 ? "raised" : "lowered"} this task (h/l ${d > 0 ? "+" : ""}${d})` });
  }

  // Snooze: a negative penalty that sinks the item toward the bottom but keeps it in
  // the queue (visible), since with few tasks the operator still wants to do it later.
  // The penalty DECAYS LINEARLY back to 0 over snoozeRecoverHours (default 5h), so the
  // item starts ~|penalty| below its natural score and slowly climbs back to it.
  if (inp.snoozePenalty && inp.snoozePenalty < 0) {
    const recoverH = inp.snoozeRecoverHours ?? 5;
    const p = effectiveSnoozePenalty(inp.snoozePenalty, inp.snoozedAt ?? null, recoverH, now);
    if (p < 0) {
      const leftH = snoozeHoursLeft(inp.snoozedAt ?? null, recoverH, now);
      terms.push({ signal: "snoozed", raw: 1, weight: p, contribution: p, note: `snoozed (${inp.snoozePenalty} decaying, now ${p}) — climbs back to natural rank in ~${leftH.toFixed(1)}h` });
    }
  }

  let score = terms.reduce((s, t) => s + t.contribution, 0);
  // Learned adjustments never move a manually scored item — the override is exact.
  if (!manualOverride) for (const lt of inp.learnedTerms) score += lt.adjustment;

  // FIX L: the just-opened ("active") task floats to the top — but NOT via a flat base added here
  // (that produced an ugly 50k). Engine.queue() repositions it to (highest organic + ACTIVE_OVER)
  // so its number stays readable. scoreItem stays purely organic.

  // Pinned: the moment it's ready, it's the next task. Add a large base so it sits
  // above any organic score, but still keep the breakdown transparent.
  if (inp.pinned) {
    add("pinned", 1, PIN_BASE, "operator pinned — forced to top when ready");
    score += PIN_BASE;
  }

  // Don't echo learned terms that weren't applied — the inspector must show exactly what summed.
  return { score: +score.toFixed(2), breakdown: terms, learned: manualOverride ? [] : inp.learnedTerms };
}

/** Time-decayed snooze penalty: starts at the full (negative) stored penalty the moment the item
 *  is snoozed and recovers LINEARLY to 0 over `recoverHours` — so a snoozed task sinks ~|penalty|
 *  below its natural score and slowly climbs back, reaching its original rank after recoverHours.
 *  A missing/unparseable stamp counts as fully recovered (legacy un-stamped snoozes don't stay
 *  sunk forever). Rounded to 0.1 so the breakdown stays readable. */
export function effectiveSnoozePenalty(penalty: number, snoozedAt: string | null | undefined, recoverHours: number, nowMs: number): number {
  if (!penalty || penalty >= 0) return 0;
  if (!snoozedAt) return 0;
  const t = Date.parse(snoozedAt.includes("T") ? snoozedAt : snoozedAt.replace(" ", "T") + "Z");
  if (isNaN(t)) return 0;
  if (!(recoverHours > 0)) return 0;
  const elapsedH = Math.max(0, (nowMs - t) / 3.6e6);
  if (elapsedH >= recoverHours) return 0;
  const remaining = penalty * (1 - elapsedH / recoverHours);
  return Math.min(0, Math.round(remaining * 10) / 10);
}

/** Hours until a snooze stamped at `snoozedAt` is fully recovered (0 if already recovered). */
export function snoozeHoursLeft(snoozedAt: string | null | undefined, recoverHours: number, nowMs: number): number {
  if (!snoozedAt) return 0;
  const t = Date.parse(snoozedAt.includes("T") ? snoozedAt : snoozedAt.replace(" ", "T") + "Z");
  if (isNaN(t)) return 0;
  return Math.max(0, recoverHours - (nowMs - t) / 3.6e6);
}

/** Cheap deterministic focus match: keyword overlap between focus and session title/text. */
export function focusMatch(focus: string, haystack: string): number {
  const f = focus.toLowerCase().trim();
  if (!f) return 0;
  const tokens = f.split(/\s+/).filter((t) => t.length >= 3);
  if (!tokens.length) return 0;
  const h = haystack.toLowerCase();
  const hits = tokens.filter((t) => h.includes(t)).length;
  return hits / tokens.length;
}
