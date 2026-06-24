/**
 * Candidate-answer options with mnemonic hotkeys.
 *
 * Each option is { key, label, text }:
 *   - key:   the single keystroke that selects+sends it (lowercase)
 *   - label: short display label ("Yes", "No", "A", …)
 *   - text:  the actual answer text sent to the session
 *
 * For a yes/no question we present Y / N (y→affirmative, n→negative). For anything
 * else we fall back to A/B/C/D. Stored as JSON in items.answer_options so the renderer
 * reads structured options directly.
 */
export interface AnswerOption {
  key: string;
  label: string;
  text: string;
}

const ABCD = ["a", "b", "c", "d"];

export function isYesNo(questionText: string): boolean {
  const q = (questionText || "").toLowerCase();
  if (/\(\s*y\s*\/\s*n\s*\)/.test(q) || /\(\s*yes\s*\/\s*no\s*\)/.test(q)) return true;
  if (/\byes\s*\/\s*no\b/.test(q)) return true;
  // "should I … ?" style binary asks with no listed multiple choices
  if (/\bshould i\b/.test(q) && /\?/.test(q) && !/\boption\b/.test(q)) return true;
  return false;
}

/**
 * Normalize raw options (strings from the LLM, or already-structured objects) into
 * keyed AnswerOptions, choosing Y/N for yes-no questions and A/B/C/D otherwise.
 */
export function normalizeOptions(
  questionText: string,
  raw: Array<string | Partial<AnswerOption>> | null | undefined
): AnswerOption[] {
  let items: Array<string | Partial<AnswerOption>> = Array.isArray(raw) ? raw : [];
  // Drop empties
  items = items.filter((o) => (typeof o === "string" ? o.trim() : o && o.text));
  if (!items.length) return [];

  // Already structured with explicit keys? keep them.
  if (items.every((o) => o && typeof o === "object" && (o as any).key && (o as any).text)) {
    return (items as AnswerOption[]).slice(0, 4).map((o) => ({ key: String(o.key).toLowerCase(), label: o.label || o.key.toUpperCase(), text: o.text }));
  }

  const texts = items.map((o) => (typeof o === "string" ? o.trim() : (o.text || "").trim())).filter(Boolean);

  if (isYesNo(questionText)) {
    const aff = texts.find((t) => /^\s*(yes|yep|sure|do it|go ahead|affirmative|enable|proceed)/i.test(t)) || texts[0] || "yes";
    const neg = texts.find((t) => /^\s*(no|nope|don'?t|do not|negative|disable|skip|cancel)/i.test(t) && t !== aff) || (texts[1] && texts[1] !== aff ? texts[1] : "no");
    return [
      { key: "y", label: "Yes", text: aff },
      { key: "n", label: "No", text: neg },
    ];
  }

  return texts.slice(0, 4).map((t, i) => ({ key: ABCD[i], label: ABCD[i].toUpperCase(), text: t }));
}
