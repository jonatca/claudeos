/**
 * Triage classifier. Routes a READY session into one of four views:
 *   SIMPLE_QUESTION | REVIEW_DIFF | COMPLEX_DECISION | FYI_DONE
 *
 * Hybrid by design (jarvis Phase 2): cheap deterministic rules first; a Claude
 * call (cheap model) only when the rules are genuinely uncertain. Every decision
 * carries its source ('rules' | 'claude') and reason so it stays tunable.
 *
 * NOTE: only call this for sessions the state detector already marked READY.
 * Working/ambiguous sessions never reach here.
 */
import { SessionState, TriageCategory } from "./db";
import { TriageConfig } from "./config";
import { claudeJson } from "./claude";

export interface TriageContext {
  state: SessionState; // WAITING_INPUT | DONE
  questionText: string; // last assistant text
  changedLines: number; // from worktree diff
  cfg: TriageConfig;
}

export interface TriageResult {
  category: TriageCategory;
  source: "rules" | "claude";
  reason: string;
}

const OPTION_MARKERS = [
  /\boption\s*(a|b|c|1|2|3)\b/gi,
  /^\s*[-*]\s+/gm,
  /\b(either|or)\b/gi,
];

function countOptions(text: string): number {
  let n = 0;
  const a = text.match(/\boption\s*(a|b|c|1|2|3)\b/gi);
  if (a) n = Math.max(n, new Set(a.map((s) => s.toLowerCase())).size);
  const bullets = text.match(/^\s*[-*]\s+\S/gm);
  if (bullets) n = Math.max(n, bullets.length >= 2 ? bullets.length : 0);
  return n;
}

function mentionsDiff(text: string): boolean {
  return /\b(diff|review (the )?(changes|patch|pr)|approve (the )?(changes|patch)|look at the (diff|changes)|ready for review)\b/i.test(
    text
  );
}

/** Deterministic first pass. Returns null when genuinely uncertain. */
export function triageRules(ctx: TriageContext): TriageResult | null {
  const { state, questionText, changedLines, cfg } = ctx;
  const text = (questionText || "").trim();

  if (state === "DONE") {
    return { category: "FYI_DONE", source: "rules", reason: "session reported done; informational" };
  }

  // From here state is WAITING_INPUT.
  const wantsReview = mentionsDiff(text);
  const bigDiff = changedLines >= cfg.review_diff_min_changed_lines;
  if (wantsReview && bigDiff) {
    return {
      category: "REVIEW_DIFF",
      source: "rules",
      reason: `asks for review and worktree has ${changedLines} changed lines`,
    };
  }

  const options = countOptions(text);
  const long = text.length > cfg.simple_question_max_chars;

  if (options >= cfg.complex_question_min_options || (long && options >= 1)) {
    return {
      category: "COMPLEX_DECISION",
      source: "rules",
      reason: `presents ${options} options / open trade-off`,
    };
  }

  if (!long && options === 0 && !wantsReview) {
    return {
      category: "SIMPLE_QUESTION",
      source: "rules",
      reason: `short closed question (${text.length} chars, no options)`,
    };
  }

  // Mixed signals: long but no clear options, or wantsReview but tiny diff.
  return null;
}

/** Full triage: rules, then Claude fallback if uncertain and enabled. */
export async function triage(ctx: TriageContext, model: string): Promise<TriageResult> {
  const ruled = triageRules(ctx);
  if (ruled) return ruled;
  if (!ctx.cfg.uncertain_calls_claude) {
    // Conservative default when Claude disabled: treat as a decision the human reads.
    return { category: "COMPLEX_DECISION", source: "rules", reason: "uncertain; Claude disabled -> default COMPLEX_DECISION" };
  }
  const prompt = `You are a triage classifier for a Claude Code session that is waiting on its operator.
Classify the operator-facing text into exactly one category:
- SIMPLE_QUESTION: a short, closed question with an obvious answerable shape (yes/no, pick one value).
- REVIEW_DIFF: it wants the operator to review code changes / a diff / a PR.
- COMPLEX_DECISION: an open-ended decision or trade-off needing judgement.
- FYI_DONE: it is just reporting completion, no action needed.
Changed lines in the worktree: ${ctx.changedLines}.
Text:
"""
${ctx.questionText.slice(0, 4000)}
"""
Return JSON: {"category": "...", "reason": "<=12 words"}`;
  const j = await claudeJson<{ category: TriageCategory; reason: string }>(prompt, {
    model,
    timeoutMs: 45000,
    label: "triage",
  });
  if (j && ["SIMPLE_QUESTION", "REVIEW_DIFF", "COMPLEX_DECISION", "FYI_DONE"].includes(j.category)) {
    return { category: j.category, source: "claude", reason: j.reason || "claude classified" };
  }
  return { category: "COMPLEX_DECISION", source: "claude", reason: "claude fallback failed -> safe default" };
}
