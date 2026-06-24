/**
 * LLM importance judge. Beyond the mechanical signals (needs-input / done / deadline),
 * a cheap model actually READS the session and decides how much it deserves the
 * operator's attention right now, given their current focus. Returns 0..100 + a short
 * reason. This becomes a (dominant) term in the priority score.
 *
 * Cheap model, one call per item, cached on the item so we don't re-pay every tick.
 */
import { claudeJson } from "./claude";

export interface ImportanceResult {
  importance: number; // 0..100
  reason: string; // <= ~14 words
}

export async function judgeImportance(
  args: {
    title: string;
    state: string; // WAITING_INPUT | DONE
    category: string;
    questionText: string;
    focus: string;
    changedLines: number;
  },
  model: string
): Promise<ImportanceResult | null> {
  const focusLine = args.focus
    ? `The operator's CURRENT FOCUS is: "${args.focus}". Sessions matching this focus are more important to them now.`
    : `The operator has not set a current focus.`;
  const prompt = `You rank a Claude Code session for a busy single operator running ~20 sessions.
Decide how much THIS one deserves their attention right now, 0 (ignore) to 100 (do immediately).
Consider: is it blocking real progress? is the decision consequential or trivial? is it quick to clear?
is it just an FYI? does it match their focus? Don't over-weight mere "needs input" — a trivial yes/no
is low; a consequential architectural decision or a broken/blocked task is high.
${focusLine}
Session title: ${args.title}
State: ${args.state} · category: ${args.category} · changed lines: ${args.changedLines}
Operator-facing text:
"""
${(args.questionText || "").slice(0, 3500)}
"""
Return JSON: {"importance": <0-100 integer>, "reason": "<=14 words on why>"}`;
  const j = await claudeJson<{ importance: number; reason: string }>(prompt, { model, timeoutMs: 45000, label: "importance" });
  if (!j || typeof j.importance !== "number") return null;
  return { importance: Math.max(0, Math.min(100, Math.round(j.importance))), reason: j.reason || "" };
}
