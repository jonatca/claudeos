/**
 * Parse cockpit-tagged PR comments posted by /pr and /prteam.
 *
 * Each tagged comment body starts with a hidden marker line:
 *   <!-- cockpit:pr     verdict=GREEN tests=pass session=task/foo ts=2026-06-08T... -->
 *   <!-- cockpit:prteam tier=deep verdict=RED rounds=3 tests=fail session=task/foo ts=... -->
 * followed by a human summary. We extract the structured fields so the cockpit can show
 * review runs + stats and link each run back to its working session by branch.
 */
export interface ReviewRun {
  type: "pr" | "prteam";
  verdict: string; // GREEN | RED | (raw)
  tier: string; // light|standard|deep (prteam only)
  rounds: string; // prteam only
  tests: string; // pass|fail|skip
  session: string; // branch name (links back to a cockpit session)
  ts: string; // ISO timestamp from the marker
  summary: string; // human text after the marker line
  author: string;
  createdAt: string; // comment createdAt (gh)
}

const MARKER_RE = /<!--\s*cockpit:(pr|prteam)\s+([^>]*?)-->/i;

function parseKv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)=("[^"]*"|\S+)/g)) {
    out[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

/** Parse an array of gh PR comments into the cockpit-tagged review runs (newest first). */
export function parseCockpitMarkers(
  comments: Array<{ body?: string; author?: any; createdAt?: string }> | null | undefined
): ReviewRun[] {
  const runs: ReviewRun[] = [];
  for (const c of comments || []) {
    const body = c?.body || "";
    const m = body.match(MARKER_RE);
    if (!m) continue;
    const kv = parseKv(m[2]);
    const summary = body.slice(m.index! + m[0].length).trim().slice(0, 600);
    const author = typeof c.author === "string" ? c.author : c.author?.login || c.author?.name || "";
    runs.push({
      type: (m[1].toLowerCase() as "pr" | "prteam"),
      verdict: (kv.verdict || "").toUpperCase(),
      tier: kv.tier || "",
      rounds: kv.rounds || "",
      tests: (kv.tests || "").toLowerCase(),
      session: kv.session || "",
      ts: kv.ts || "",
      summary,
      author,
      createdAt: c.createdAt || "",
    });
  }
  // newest first by ts (fallback createdAt)
  runs.sort((a, b) => (b.ts || b.createdAt || "").localeCompare(a.ts || a.createdAt || ""));
  return runs;
}

/** LOOSE fallback: real /prteam runs don't always emit the hidden marker (compliance is spotty —
 *  e.g. "## Review notes (prteam — standard, converged)" with no marker line). Without this the
 *  cockpit would claim "no reviews yet" on a PR that was plainly prteam-reviewed. Conservative:
 *  only substantial comments that name prteam (or read as review notes) count, and the verdict is
 *  left UNKNOWN ("") rather than guessed. */
export function parseLooseReviewRuns(
  comments: Array<{ body?: string; author?: any; createdAt?: string }> | null | undefined
): ReviewRun[] {
  const runs: ReviewRun[] = [];
  for (const c of comments || []) {
    const body = (c?.body || "").trim();
    if (!body || MARKER_RE.test(body)) continue; // tagged → already parsed properly
    // judge the FIRST LINE for a REPORT shape ("## Review notes (prteam…)", "Reviewed (2-pass
    // /prteam loop)…") — a comment merely MENTIONING prteam is not a run — and require substance:
    // the body names prteam OR is a real report (≥300 chars). "Reviewed, LGTM" is neither.
    const firstLine = (body.split("\n")[0] || "").trim();
    if (!/^(#{1,6}\s*|\*{1,2})?\s*review(ed\b|\s+notes)/i.test(firstLine)) continue;
    if (!/\bprteam\b/i.test(body) && body.length < 300) continue;
    const author = typeof c.author === "string" ? c.author : c.author?.login || c.author?.name || "";
    runs.push({
      type: "prteam", verdict: "", tier: "", rounds: "", tests: "", session: "", ts: "",
      summary: body.slice(0, 600), author, createdAt: c.createdAt || "",
    });
  }
  return runs;
}

/** All review runs on a PR: properly-tagged cockpit markers + the loose untagged fallback,
 *  newest first. */
export function parseReviewRuns(
  comments: Array<{ body?: string; author?: any; createdAt?: string }> | null | undefined
): ReviewRun[] {
  const runs = [...parseCockpitMarkers(comments), ...parseLooseReviewRuns(comments)];
  runs.sort((a, b) => (b.ts || b.createdAt || "").localeCompare(a.ts || a.createdAt || ""));
  return runs;
}

export interface ReviewStats {
  prs: number; // distinct PRs that have >=1 cockpit run
  prRuns: number; // count of /pr runs
  prteamRuns: number; // count of /prteam runs
  green: number;
  red: number;
}

/** Aggregate stats across many PRs' review runs. */
export function reviewStats(perPr: ReviewRun[][]): ReviewStats {
  const s: ReviewStats = { prs: 0, prRuns: 0, prteamRuns: 0, green: 0, red: 0 };
  for (const runs of perPr) {
    if (!runs.length) continue;
    s.prs++;
    for (const r of runs) {
      if (r.type === "pr") s.prRuns++;
      else s.prteamRuns++;
      if (r.verdict === "GREEN") s.green++;
      else if (r.verdict === "RED") s.red++;
    }
  }
  return s;
}
