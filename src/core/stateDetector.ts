/**
 * State detection — the safety-critical core.
 *
 * CRITICAL RULE: never report a session as actionable unless it is genuinely
 * waiting on the operator or finished. A session that is still working / streaming /
 * running a tool, or whose state is ambiguous, must resolve to a NON-ready state
 * (WORKING or UNKNOWN) so the UI keeps it hidden.
 *
 * Signals, in order of trust:
 *   1. Process liveness + transcript recency. If the transcript was written within
 *      `quietPeriodMs`, Claude is almost certainly mid-stream  -> WORKING.
 *   2. The last assistant turn's stop_reason:
 *        - 'tool_use'           -> mid-turn, a tool is running        -> WORKING
 *        - missing / not end_turn-> control not cleanly returned       -> WORKING
 *        - 'end_turn'           -> control returned to the human       -> candidate READY
 *   3. For a returned turn, the background-session text conventions are the
 *      strongest done/needs-input signal we have, and exactly what these sessions
 *      emit:  ^result:  -> DONE,  ^needs input: -> WAITING_INPUT,  ^failed: -> DONE(failed).
 *   4. Otherwise, if the returned text clearly asks the operator a question
 *      -> WAITING_INPUT. If it does not look like a question and has no done marker,
 *      we cannot be sure the operator is needed -> UNKNOWN (stays hidden).
 */
import { SessionState } from "./db";
import { TranscriptView, Turn, pendingInteractivePrompt } from "./transcript";

export interface DetectInput {
  view: TranscriptView | null;
  processAlive: boolean;
  /** ms since the transcript file was last modified (Infinity if unknown/no file). */
  msSinceWrite: number;
  quietPeriodMs: number;
}

export interface DetectResult {
  state: SessionState;
  reason: string; // human-readable WHY, surfaced in the UI
  ready: boolean; // convenience: state is WAITING_INPUT or DONE
  /** Set to the tool name (AskUserQuestion / ExitPlanMode) when the session is parked on an
   *  interactive prompt UI. This is MECHANICAL truth, not a heuristic: these tools run nothing —
   *  a pending one means the select/approval dialog is on screen waiting for the operator. The
   *  engine may surface on it without (and despite) a model verdict. */
  interactivePrompt?: string;
}

// Phrases that mean control has been explicitly handed to the operator: either an
// open question OR a review/approval hand-off. Both are genuine WAITING_INPUT.
const QUESTION_HINTS = [
  /\?\s*$/m,
  /\bwould you like\b/i,
  /\bshould i\b/i,
  /\bdo you want\b/i,
  /\bwhich (one|option|approach)\b/i,
  /\b(option a|option b|option 1|option 2)\b/i,
  /\bplease (confirm|choose|pick|decide|clarify|review|approve|let me know)\b/i,
  /\bwaiting (for|on) (your|you)\b/i,
  /\bready for (your )?(review|approval)\b/i,
  /\breview the (diff|changes|pr|patch)\b/i,
  /\blet me know (if|whether|how)\b/i,
  /\bawaiting your (input|review|approval|decision)\b/i,
];

function classifyReturnedText(text: string): { state: SessionState; reason: string } {
  const t = text || "";
  // Background-session conventions (own line). Highest trust.
  if (/^\s*result:/im.test(t)) return { state: "DONE", reason: "transcript emitted `result:` marker" };
  if (/^\s*failed:/im.test(t))
    return { state: "DONE", reason: "transcript emitted `failed:` marker (done, failed)" };
  if (/^\s*needs input:/im.test(t))
    return { state: "WAITING_INPUT", reason: "transcript emitted `needs input:` marker" };
  // Heuristic question detection.
  for (const re of QUESTION_HINTS)
    if (re.test(t))
      return { state: "WAITING_INPUT", reason: "last turn asks the operator a question" };
  // FIX W: the turn ENDED cleanly (control is with the human) but it's neither a question nor a
  // result marker. It is NOT actively working — it's IDLE. If it reads like a completion, call it
  // DONE (medium prio); otherwise UNKNOWN = idle (surfaced at LOW prio, never hidden). Only an
  // ACTIVELY-working session (handled above) stays hidden.
  if (/\b(done|finished|completed?|updated|committed|created|added|fixed|merged|pushed|deployed|implemented|all tests pass(ing)?|ready to)\b/i.test(t))
    return { state: "DONE", reason: "turn ended on a completion statement (idle/finished)" };
  return {
    state: "UNKNOWN",
    reason: "turn ended; session is idle (no question / no done-marker) — surfaced at low priority",
  };
}

export function detectState(input: DetectInput): DetectResult {
  const { view, processAlive, msSinceWrite, quietPeriodMs } = input;

  if (!view || view.turns.length === 0) {
    return {
      state: processAlive ? "WORKING" : "UNKNOWN",
      reason: processAlive ? "process alive, no transcript yet" : "no transcript / no process",
      ready: false,
    };
  }

  // 0. A PENDING INTERACTIVE PROMPT outranks every WORKING signal below. AskUserQuestion (the
  // up/down-arrow select UI) and ExitPlanMode (plan approval) are tool_use blocks, so rule 2
  // reads them as "a tool is running ⇒ WORKING" — but these tools run NOTHING: pending means the
  // dialog is on screen, blocked on the operator, and the transcript will never be written again
  // until they act. That made the one state the queue most exists for the one state it was
  // guaranteed to hide (2026-06-11, session new-claude-session-337: an AskUserQuestion sat
  // invisible until the operator found the pane by hand). Checked before the recency rule too —
  // the prompt's own write must not buy it a quiet-period of hiding. The engine's Layer-1
  // double-sample still absorbs the sub-second window where a parallel sibling tool_use of the
  // same message hasn't landed yet.
  if (processAlive) {
    const prompt = pendingInteractivePrompt(view);
    if (prompt) {
      return {
        state: "WAITING_INPUT",
        reason: `interactive ${prompt} prompt is open — waiting on the operator`,
        ready: true,
        interactivePrompt: prompt,
      };
    }
  }

  // 1. Recently written transcript while process alive => actively streaming.
  if (processAlive && msSinceWrite < quietPeriodMs) {
    return {
      state: "WORKING",
      reason: `transcript written ${Math.round(msSinceWrite)}ms ago (< quiet period) — streaming`,
      ready: false,
    };
  }

  const last: Turn | null = view.lastAssistant;

  // 2. No assistant turn at all, or last assistant didn't end the turn cleanly.
  if (!last) {
    return { state: processAlive ? "WORKING" : "UNKNOWN", reason: "no assistant turn yet", ready: false };
  }
  if (last.stop_reason === "tool_use" || last.hasToolUse) {
    // A tool_use tail is "mid-turn" ONLY while the process is alive. If the process is DEAD (crashed,
    // killed, or exited mid-tool) it is NOT working — it STALLED. Pinning it to WORKING forever is the
    // bug that hides a dead session from the queue permanently; surface it as idle so the operator sees
    // it and can act/complete it.
    if (processAlive)
      return { state: "WORKING", reason: "last assistant turn is a tool_use (mid-turn)", ready: false };
    return { state: "UNKNOWN", reason: "process exited on a tool_use — stalled, not working", ready: false };
  }

  // If a user tool_result is the very last meaningful entry, Claude is about to
  // continue -> still working (but only if the process is actually still alive).
  const lastTurn = view.turns[view.turns.length - 1];
  if (lastTurn.role === "user" && lastTurn.isToolResult) {
    if (processAlive)
      return { state: "WORKING", reason: "awaiting assistant continuation after tool_result", ready: false };
    return { state: "UNKNOWN", reason: "process exited awaiting continuation — stalled, not working", ready: false };
  }

  // A real OPERATOR reply is the very last entry and the process is alive => the assistant is
  // generating its response RIGHT NOW (the partial reply isn't in the transcript yet — .jsonl is
  // written per completed message, not per token). Without this, `lastAssistant` is the PREVIOUS
  // (now-stale) turn — typically the question the operator just answered — which classifies as
  // WAITING_INPUT and gets surfaced mid-reply: the exact "still outputting tokens" false-surface.
  // Mirrors the tool_result rule above (and shares its property: unbounded by recency).
  if (lastTurn.role === "user" && !lastTurn.isToolResult && lastTurn.text && processAlive) {
    return { state: "WORKING", reason: "operator just replied; assistant is responding", ready: false };
  }

  if (last.stop_reason && last.stop_reason !== "end_turn" && last.stop_reason !== "stop_sequence") {
    return {
      state: processAlive ? "WORKING" : "UNKNOWN",
      reason: `last turn stop_reason='${last.stop_reason}' (not a clean end_turn)`,
      ready: false,
    };
  }

  // 3 & 4. Turn cleanly returned to the human. Classify done vs needs-input.
  const c = classifyReturnedText(last.text);
  return { state: c.state, reason: c.reason, ready: c.state === "DONE" || c.state === "WAITING_INPUT" };
}
