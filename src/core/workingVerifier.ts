/**
 * workingVerifier.ts — the Haiku semantic classifier (Layer 2, the FINAL GATE before Up Next).
 *
 * WHY a model: the heuristic detector (stateDetector.ts) marks state on cheap signals — a
 * `tool_use` last turn, a non-`end_turn` stop_reason, or simply "the transcript was written within
 * quiet_period_ms" — REGARDLESS of what was actually written. So a session that finished and is now
 * parked on a question reads WORKING (hidden) for the whole quiet window, and a session that merely
 * PRINTED something while still grinding on its own background job can read as DONE. We don't trust
 * either. Before anything enters Up Next a cheap model READS the tail and gets the final say.
 *
 * It classifies into the four operator-meaningful states (card 288), reconciled with SessionState:
 *   WORKING            → still generating / a tool is running        → SessionState WORKING  (HIDE)
 *   WAITING_ON_SELF    → stopped, but blocked on its OWN script/job   → SessionState WORKING  (HIDE)
 *                        with nothing for the operator to do
 *   WAITING_ON_OPERATOR→ genuinely needs the operator (question/ok)   → SessionState WAITING_INPUT (SURFACE)
 *   DONE               → finished, only reporting the result          → SessionState DONE         (SURFACE)
 *   UNKNOWN            → genuinely unclear                             → SessionState UNKNOWN (idle, low prio)
 *
 * So `working` (= keep hidden) is TRUE for both WORKING and WAITING_ON_SELF — the two "not for you
 * yet" states. Only WAITING_ON_OPERATOR / DONE are allowed to surface.
 *
 * The model is advisory and STOCHASTIC even at temperature 0 (SentinelAgent, arXiv 2505.24201), so
 * it is used CONSERVATIVELY: it runs only AFTER the free double-sample stability gate (engine), it
 * only ever moves a session toward MORE hidden or confirms a stable candidate, and any failure
 * returns null → the caller keeps the (hidden) heuristic verdict. Cost is bounded by the caller:
 * classify only settled candidates, cache by transcript mtime, throttle re-checks.
 *
 * Sources: Anthropic "Handling stop reasons" (end_turn can appear on empty 2-3 token replies; infer
 * from content blocks, not the field alone) https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons ;
 * claudectl (permission/self-blocked sessions leave no clean transcript signal)
 * https://mercurialsolo.github.io/posts/claudectl-tui-dashboard/ .
 */
import { SessionState } from "./db";
import { TranscriptView } from "./transcript";
import { claudeJson } from "./claude";

/** The four operator-meaningful activity classes the model picks from (card 288), plus UNKNOWN. */
export type ActivityClass = "WORKING" | "WAITING_ON_SELF" | "WAITING_ON_OPERATOR" | "DONE" | "UNKNOWN";

export interface WorkingVerdict {
  working: boolean;       // true = NOT for the operator yet (WORKING or WAITING_ON_SELF) → keep hidden
  activity: ActivityClass; // the raw 4-way class (for the reason line / logging / learning)
  state: SessionState;    // reconciled SessionState the engine should adopt when surfacing
  reason: string;
  /** When the tail STATES its own time estimate ("ETA ~40 min") and the verdict is a self-wait,
   *  the extracted minutes — the engine turns it into the roster countdown (ETA hold). */
  etaMinutes?: number | null;
}

const VALID: ActivityClass[] = ["WORKING", "WAITING_ON_SELF", "WAITING_ON_OPERATOR", "DONE", "UNKNOWN"];

/** How much raw transcript tail the classifier reads. Cost scales with this (cache-write is the
 *  dominant per-call cost). 4500 is the floor that keeps questions inside the window: raw JSONL
 *  tails end in ~2k chars of metadata lines (hooks/usage), and at 3500 the goldset's real questions
 *  fell outside it (still 0 false-surfaces, but OPERATOR cards demoted to DONE). */
export const VERIFIER_TAIL_CHARS = 4500;

/** Bump when the prompt or the tail pipeline changes semantics: persisted per-mtime verdicts from
 *  an older revision must NOT be reused (2026-06-12: a DONE report was pinned hidden forever by a
 *  cached WORKING verdict from the pre-filter pipeline). */
export const VERDICT_REV = 2;

/** The model's input: ONLY real conversation lines. Raw transcripts end in bookkeeping entries
 *  (last-prompt / bridge-session / mode / ai-title / system…) written AFTER the assistant's final
 *  turn — the echoed last-prompt line reads like a fresh operator message and trips the
 *  "human's message last ⇒ WORKING" rule (2026-06-12: session-390's dry-run report stayed hidden;
 *  haiku cited a 'continue' message that didn't exist). Deterministic filter, then the size cap. */
export function verifierTail(raw: string): string {
  const keep: string[] = [];
  for (const line of (raw || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line)?.type;
      if (t === "assistant" || t === "user") keep.push(line);
    } catch { /* partial first line / junk — drop */ }
  }
  return keep.join("\n").slice(-VERIFIER_TAIL_CHARS);
}

/** Pure mapping from an activity class to the engine's verdict. Exported for unit tests — this is
 *  the reconciliation table above, and it must keep WAITING_ON_SELF HIDDEN. */
export function mapActivity(activity: ActivityClass, reason: string): WorkingVerdict {
  switch (activity) {
    case "WORKING":
      return { working: true, activity, state: "WORKING", reason };
    case "WAITING_ON_SELF":
      return { working: true, activity, state: "WORKING", reason };
    case "WAITING_ON_OPERATOR":
      return { working: false, activity, state: "WAITING_INPUT", reason };
    case "DONE":
      return { working: false, activity, state: "DONE", reason };
    default:
      return { working: false, activity: "UNKNOWN", state: "UNKNOWN", reason };
  }
}

/** Pure parse of the model's JSON into a verdict; null on a missing/invalid class. Exported so the
 *  parse + mapping can be unit-tested without spending a token. */
export function parseVerdict(j: { state?: string; reason?: string; eta_minutes?: number | null } | null): WorkingVerdict | null {
  if (!j || typeof j.state !== "string") return null;
  const activity = j.state.trim().toUpperCase() as ActivityClass;
  if (!VALID.includes(activity)) return null;
  const v = mapActivity(activity, (j.reason || "haiku verdict").slice(0, 160));
  if (typeof j.eta_minutes === "number" && isFinite(j.eta_minutes) && j.eta_minutes > 0) v.etaMinutes = Math.round(j.eta_minutes);
  return v;
}

/** The classifier prompt — kept here so tests and reviewers can read exactly what the model is
 *  asked. Judges ONLY the END of the transcript, NOT how long ago or how much work remains. */
export function classifierPrompt(tail: string): string {
  return `You are watching a Claude Code coding session to decide its CURRENT state for a dashboard that must NEVER show the human operator a session that isn't actually ready for them. Judge ONLY from what the assistant actually wrote at the very END of the transcript — NOT from how long ago it was, NOT from how much work remains.

Pick exactly one:
- WORKING: it is mid-task RIGHT NOW — the last thing is a tool call it is running, an unfinished/streaming thought, or it clearly intends to keep going on its own. The human is NOT expected to act.
- WAITING_ON_SELF: it has STOPPED generating but the work is NOT over and needs nothing from the human — it is waiting on its OWN job (a long command/build/test/training/upload it kicked off, a background task, a sleep/poll/scheduled wake-up), or it is a watcher/babysitter that just printed a periodic status and keeps watching. There is NOTHING for the operator to do. (e.g. "running the test suite…", "uploading, ~90 min, next steps run automatically", "kicked off the build, will check back", "monitoring continues — next check in 30 min", "all clean, will ping you only if something breaks".)
- WAITING_ON_OPERATOR: it has stopped and genuinely needs the OPERATOR before it can continue — a question awaiting an answer, a choice between options, a permission/approval, a credential, or an explicit "review this / your call". Control is with the human.
- DONE: the WHOLE task is finished and it is only reporting the final result. No further action by anyone, nothing left running, nothing scheduled.
- UNKNOWN: it stopped but it's genuinely unclear — neither an obvious question, nor an obvious completion, nor obviously waiting on its own job.

Decisive rules:
- NEVER reason from timestamps, dates, or elapsed time in the transcript ("that was 6 days ago", "the ETA has passed") — you cannot know the current time, and age is judged elsewhere. Judge only WHAT was written.
- A tool call as the last entry ⇒ WORKING — EXCEPT the interactive prompt tools: a "tool_use" of AskUserQuestion (the arrow-key select dialog) or ExitPlanMode (plan approval) with no tool_result after it means the question/approval dialog is ON SCREEN waiting for the human ⇒ WAITING_ON_OPERATOR. These tools run nothing; they ARE the question.
- The HUMAN's message (or a tool result) as the last entry ⇒ the assistant is about to respond ⇒ WORKING, never UNKNOWN.
- "I'm running X / waiting for X to finish / will check back / will report when it lands" with no question to the human ⇒ WAITING_ON_SELF (NOT done).
- A periodic monitoring/babysitting/status-heartbeat report ("all healthy, next check in N min", "watching the run") ⇒ WAITING_ON_SELF — the watch loop itself is the ongoing job. It is NEVER DONE just because one check cycle came back clean.
- A sub-step finished but more steps continue automatically (or anything is still running/uploading/training/scheduled) ⇒ WAITING_ON_SELF, even if the message is full of ✓s, "fixed", "verified", "complete".
- A question/choice/approval/credential request the human must answer before progress ⇒ WAITING_ON_OPERATOR.
- The whole task finished, with only an OPTIONAL trailing offer ("let me know if you also want X", "say the word and I'll …") the human can freely ignore ⇒ DONE, not WAITING_ON_OPERATOR — unless it explicitly says it is blocked waiting for that answer.
- Some EXTERNAL party (a customer, another team) having to act someday does not make it WAITING_ON_OPERATOR; if this session's own task is wrapped up, it's DONE.

Transcript tail:
"""
${tail}
"""
Return JSON: {"state":"WORKING|WAITING_ON_SELF|WAITING_ON_OPERATOR|DONE|UNKNOWN","reason":"<=12 words why","eta_minutes":<integer minutes ONLY when the text itself states/implies a time estimate for ITS OWN remaining work (e.g. "ETA ~40 min" => 40, "another 2h" => 120); else null>}`;
}

/** Read the transcript tail and judge the assistant's CURRENT state. Returns null on any model
 *  failure so the caller degrades to the heuristic (stays WORKING — conservative). */
export async function verifyWorking(view: TranscriptView, model: string): Promise<WorkingVerdict | null> {
  const tail = verifierTail(view.raw || "");
  if (!tail.trim()) return null;
  const j = await claudeJson<{ state: string; reason: string }>(classifierPrompt(tail), { model, timeoutMs: 30000, label: "state-gate" });
  return parseVerdict(j);
}
