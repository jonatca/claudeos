/**
 * Adaptive-view content generation (jarvis "DRAFT" stage, repurposed).
 * For each category we pre-compute exactly what the operator should see so they
 * never have to read the raw transcript unless they choose to:
 *   SIMPLE_QUESTION  -> one-line context + a suggested answer they accept/edit/send
 *   REVIEW_DIFF      -> a summarized diff (full patch always one keystroke away)
 *   COMPLEX_DECISION -> the context the decision needs + pointer to raw transcript
 *   FYI_DONE         -> a single "this finished: <summary>" line
 *
 * Uses the stronger model (sonnet) since this is the low-volume text the human reads.
 * Degrades to deterministic fallbacks if the model call fails, so the cockpit always works.
 */
import { TriageCategory } from "./db";
import { claudeJson } from "./claude";

export interface SummaryInput {
  category: TriageCategory;
  questionText: string;
  recentTranscript: string; // tail of raw transcript for context
  diffStat?: string;
  diffPatch?: string;
  extraContextRequested?: boolean; // feedback loop: operator wanted more context here
  model: string;
}

export interface SummaryOutput {
  one_liner: string;
  suggested_answer: string | null;
  diff_summary: string | null;
  options: string[] | null; // 2-4 distinct candidate answers (A/B/C/D)
}

function firstSentence(s: string, max = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  const m = t.match(/^.*?[.?!](\s|$)/);
  const out = (m ? m[0] : t).trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

export async function summarize(input: SummaryInput): Promise<SummaryOutput> {
  const { category } = input;
  const fallback: SummaryOutput = {
    one_liner: firstSentence(input.questionText || input.recentTranscript || "(no text)"),
    suggested_answer: null,
    diff_summary: input.diffStat || null,
    options: null,
  };

  if (category === "FYI_DONE") {
    const j = await claudeJson<{ one_liner: string }>(
      `A Claude Code session just finished. In one short line (<=14 words), say what it accomplished.\nFinal output:\n"""${input.questionText.slice(0, 3000)}"""`,
      { model: input.model, timeoutMs: 90000, label: "summarize" }
    );
    return { one_liner: j?.one_liner || fallback.one_liner, suggested_answer: null, diff_summary: null, options: null };
  }

  if (category === "REVIEW_DIFF") {
    const j = await claudeJson<{ one_liner: string; diff_summary: string }>(
      `Summarize this code change for a fast review. Give a one-line gist and a 2-4 bullet summary of what changed and any risk.\nDiff stat:\n${input.diffStat || ""}\nPatch (may be truncated):\n"""${(input.diffPatch || "").slice(0, 8000)}"""`,
      { model: input.model, timeoutMs: 90000, label: "summarize" }
    );
    return {
      one_liner: j?.one_liner || fallback.one_liner,
      suggested_answer: null,
      diff_summary: j?.diff_summary || input.diffStat || null,
      options: null,
    };
  }

  // SIMPLE_QUESTION or COMPLEX_DECISION: one-liner + 2-4 distinct candidate answers.
  const wantContext = input.extraContextRequested
    ? "The operator has previously wanted MORE context for this kind of item, so include 1-2 extra lines of relevant context."
    : "Keep context to a single line.";
  const j = await claudeJson<{ one_liner: string; suggested_answer: string; options: string[] }>(
    `A Claude Code session is waiting on its operator. ${wantContext}
Provide:
1. one_liner: a single line of context so the operator understands the question without reading the transcript.
2. options: an array of 2-4 DISTINCT candidate answers the operator could send back, each phrased exactly as what they'd type to the session — concrete and decisive, ordered best-first. For a yes/no question include both. For a multiple-choice decision, one per choice.
3. suggested_answer: the single best answer (this should equal options[0]).
Question / situation:
"""${input.questionText.slice(0, 4000)}"""
Recent transcript tail (for context):
"""${(input.recentTranscript || "").slice(-3000)}"""`,
    { model: input.model, timeoutMs: 90000, label: "summarize" }
  );
  let options: string[] | null = null;
  if (j && Array.isArray(j.options)) {
    options = j.options.filter((o) => typeof o === "string" && o.trim()).slice(0, 4).map((o) => o.trim());
    if (!options.length) options = null;
  }
  const suggested = j?.suggested_answer || (options ? options[0] : null);
  return {
    one_liner: j?.one_liner || fallback.one_liner,
    suggested_answer: suggested,
    diff_summary: null,
    options,
  };
}
