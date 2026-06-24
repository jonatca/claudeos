/**
 * SESSION SEARCH — full-history search over every Claude session on this box
 * (~/.claude/projects/<enc-cwd>/<uuid>.jsonl, thousands of files, some 20MB+).
 *
 * Two modes, matching the UI:
 *   - keywordSearch(): instant substring scoring, runs on every keystroke.
 *   - semanticRank():  Enter → `claude -p` (sonnet) re-ranks the lexical
 *     candidate pool and returns the TOP 5 semantically-matching sessions.
 *     Degrades to keyword top-5 whenever claude is unavailable/slow/garbled.
 *
 * Indexing is the hard part: transcripts are huge, so we NEVER read whole
 * files — only a bounded HEAD (first user prompt, cwd) + TAIL (latest
 * ai-title, last-prompt) per file, ~512KB worst case. Entries are cached by
 * (path, mtime) in a JSON sidecar so a rebuild only re-reads changed files.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claudePrompt } from "./claude";

export type SearchEntry = {
  claude_session_id: string;
  title: string;        // latest ai-title ("" if none)
  first: string;        // first real user prompt (head)
  last: string;         // last-prompt (tail)
  cwd: string;
  transcript_path: string;
  mtimeMs: number;
};

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
const SNIPPET = 600;

export function projectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

async function readSlice(file: string, start: number, len: number): Promise<string> {
  const fh = await fs.promises.open(file, "r");
  try {
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** First REAL user prompt out of a chunk of jsonl lines (skips tool_results, <meta>, Caveat:). */
function firstUserPrompt(lines: string[]): string {
  for (const line of lines) {
    if (!line.includes('"user"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "user") continue;
    const c = o.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c))
      text = c.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text).join(" ");
    text = (text || "").trim();
    if (!text || text.startsWith("<") || text.startsWith("Caveat:")) continue;
    return text.slice(0, SNIPPET);
  }
  return "";
}

/** Head+tail extraction for one transcript. Returns null for sessions with no usable text. */
export async function extractEntry(file: string, mtimeMs: number): Promise<SearchEntry | null> {
  let size = 0;
  try { size = (await fs.promises.stat(file)).size; } catch { return null; }
  if (size === 0) return null;

  const head = await readSlice(file, 0, Math.min(HEAD_BYTES, size));
  const headLines = head.split("\n");
  if (size > HEAD_BYTES) headLines.pop(); // last line may be truncated

  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = tailStart === 0 ? head : await readSlice(file, tailStart, size - tailStart);
  const tailLines = tail.split("\n");
  if (tailStart > 0) tailLines.shift(); // first line may be truncated

  let cwd = "", sessionId = "", title = "", last = "";
  for (const line of headLines) {
    if (!cwd && line.includes('"cwd"')) {
      try { const o = JSON.parse(line); if (o.cwd) cwd = o.cwd; } catch {}
    }
    if (!sessionId && line.includes('"sessionId"')) {
      try { const o = JSON.parse(line); if (o.sessionId) sessionId = o.sessionId; } catch {}
    }
    if (cwd && sessionId) break;
  }
  // latest ai-title / last-prompt win → scan the tail bottom-up
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    if (!title && line.includes('"ai-title"')) {
      try { const o = JSON.parse(line); if (o.type === "ai-title" && o.aiTitle) title = o.aiTitle; } catch {}
    }
    if (!last && line.includes('"last-prompt"')) {
      try { const o = JSON.parse(line); if (o.type === "last-prompt" && o.lastPrompt) last = String(o.lastPrompt).slice(0, SNIPPET); } catch {}
    }
    if (title && last) break;
  }
  const first = firstUserPrompt(headLines);
  if (!title && !first && !last) return null;
  // STUB GUARD: the cockpit's own `claude -p` helpers (title/tag enrichment, neutral /tmp
  // cwd) leave 1-line transcripts holding ONLY an ai-title — and that title paraphrases the
  // OPERATOR'S OWN TASK, so it's a perfect decoy in search results. A real session always
  // records a cwd and a user turn; no cwd + no user content = internal stub, never indexed
  // (opening one fabricated a phantom $HOME card — the 2026-06-11 vanished-task incident).
  if (!cwd && !first) return null;
  return {
    claude_session_id: sessionId || path.basename(file, ".jsonl"),
    title, first, last, cwd,
    transcript_path: file,
    mtimeMs,
  };
}

/**
 * Build (or refresh) the index. `cacheFile` persists entries keyed by transcript path;
 * a file whose mtime is unchanged is reused without touching it. Yields to the event
 * loop every few files so a cold build never starves the engine tick.
 */
export async function buildIndex(cacheFile?: string, baseDir?: string): Promise<SearchEntry[]> {
  const base = baseDir || projectsDir();
  const cache = new Map<string, SearchEntry>();
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      for (const e of JSON.parse(fs.readFileSync(cacheFile, "utf8")) as SearchEntry[]) {
        if (!e.cwd && !e.first) continue; // stale pre-guard stub entries (see extractEntry) — drop on load
        cache.set(e.transcript_path, e);
      }
    } catch {}
  }
  const files: string[] = [];
  try {
    for (const dir of await fs.promises.readdir(base)) {
      // The cockpit's own `claude -p` helpers run from the neutral tmp cwd; their project dir
      // holds only 1-line ai-title stubs (thousands of them). Skip wholesale — the per-entry
      // stub guard in extractEntry still covers stubs that land anywhere else.
      if (dir === "-tmp-cockpit-claude-neutral") continue;
      const abs = path.join(base, dir);
      let names: string[] = [];
      try { names = await fs.promises.readdir(abs); } catch { continue; }
      for (const n of names) if (n.endsWith(".jsonl")) files.push(path.join(abs, n));
    }
  } catch { return []; }

  const out: SearchEntry[] = [];
  let sinceYield = 0;
  for (const file of files) {
    let mtimeMs = 0;
    try { mtimeMs = (await fs.promises.stat(file)).mtimeMs; } catch { continue; }
    const cached = cache.get(file);
    if (cached && Math.abs(cached.mtimeMs - mtimeMs) < 1) { out.push(cached); continue; }
    try {
      const e = await extractEntry(file, mtimeMs);
      if (e) out.push(e);
    } catch {}
    if (++sinceYield >= 5) { sinceYield = 0; await new Promise((r) => setImmediate(r)); }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(out));
    } catch {}
  }
  return out;
}

function haystack(e: SearchEntry): string {
  return (e.title + "\n" + e.first + "\n" + e.last + "\n" + e.cwd).toLowerCase();
}

/** Instant as-you-type filter: every term must be scored, title hits weigh 3x extra. */
export function keywordSearch(index: SearchEntry[], q: string, limit = 30): SearchEntry[] {
  const query = (q || "").trim().toLowerCase();
  if (!query) return index.slice(0, limit); // empty query → most recent
  const terms = query.split(/\s+/).filter(Boolean);
  const scored: { s: number; e: SearchEntry }[] = [];
  for (const e of index) {
    const hay = haystack(e);
    let score = 0;
    for (const t of terms) {
      let n = 0, i = -1;
      while ((i = hay.indexOf(t, i + 1)) !== -1 && n < 20) n++;
      if (n) {
        score += n;
        if (e.title.toLowerCase().includes(t)) score += 3;
      }
    }
    if (score) scored.push({ s: score, e });
  }
  scored.sort((a, b) => b.s - a.s || b.e.mtimeMs - a.e.mtimeMs);
  return scored.slice(0, limit).map((x) => x.e);
}

/** Lexical candidate pool for the semantic pass: keyword hits padded with most-recent. */
export function candidatePool(index: SearchEntry[], q: string, limit = 60): SearchEntry[] {
  const hits = keywordSearch(index, q, limit);
  if (hits.length >= limit) return hits;
  const seen = new Set(hits.map((e) => e.transcript_path));
  for (const e of index) {
    if (seen.has(e.transcript_path)) continue;
    hits.push(e);
    if (hits.length >= limit) break;
  }
  return hits;
}

export type SemanticResult = { results: SearchEntry[]; via: "semantic" | "keyword-fallback"; error?: string };

/**
 * Enter → smart search: hand the candidate pool to a Claude model (default sonnet) and let it
 * pick the 5 best semantic matches. `ranker` is injectable for tests; production uses
 * claudePrompt (lean mode — no MCP / project CLAUDE.md, ~seconds not minutes).
 */
export async function semanticRank(
  index: SearchEntry[],
  q: string,
  opts: { model?: string; timeoutMs?: number; ranker?: (prompt: string) => Promise<string | null> } = {}
): Promise<SemanticResult> {
  const fallback = (error: string): SemanticResult =>
    ({ results: keywordSearch(index, q, 5), via: "keyword-fallback", error });
  const cands = candidatePool(index, q);
  if (!cands.length) return { results: [], via: "semantic" };
  const listing = cands
    .map((e, i) => `[${i}] ${e.title || "(untitled)"} :: ${(e.first || e.last).replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");
  const prompt =
    "You are ranking a user's past Claude Code sessions by how well they semantically match a " +
    "search query. The user may describe a topic, a bug, a feature, or a goal — match on meaning, " +
    `not just keywords.\n\nQUERY: ${q}\n\nCANDIDATE SESSIONS (index :: title :: first prompt):\n` +
    `${listing}\n\nReturn ONLY a JSON array of the 5 best-matching indices, best first, e.g. ` +
    '[3,0,12,7,1]. No prose, no code fences.';
  const ranker = opts.ranker || ((p: string) => claudePrompt(p, { model: opts.model || "sonnet", timeoutMs: opts.timeoutMs ?? 60_000, label: "session-search" }));
  let raw: string | null = null;
  try { raw = await ranker(prompt); } catch (e: any) { return fallback(String(e?.message || e)); }
  if (raw == null) return fallback("claude unavailable or timed out");
  const m = String(raw).match(/\[[\d,\s]+\]/);
  if (!m) return fallback("unparseable ranking");
  let idxs: any;
  try { idxs = JSON.parse(m[0]); } catch { return fallback("bad ranking JSON"); }
  const results: SearchEntry[] = [];
  for (const i of idxs)
    if (Number.isInteger(i) && i >= 0 && i < cands.length && results.length < 5) results.push(cands[i]);
  if (!results.length) return fallback("empty ranking");
  return { results, via: "semantic" };
}

/**
 * Server-side singleton: lazily builds the index on first search, then refreshes in the
 * background at most every `refreshMs` (mtime-cached → a refresh only re-reads changed files).
 */
export class SessionSearchService {
  private index: SearchEntry[] | null = null;
  private building: Promise<SearchEntry[]> | null = null;
  private builtAt = 0;
  constructor(private cacheFile?: string, private refreshMs = 60_000, private baseDir?: string) {}

  async ensure(): Promise<SearchEntry[]> {
    if (this.building) return this.building;
    if (this.index && Date.now() - this.builtAt < this.refreshMs) return this.index;
    this.building = buildIndex(this.cacheFile, this.baseDir)
      .then((idx) => { this.index = idx; this.builtAt = Date.now(); return idx; })
      .finally(() => { this.building = null; });
    return this.building;
  }

  async search(q: string, limit = 30): Promise<SearchEntry[]> {
    return keywordSearch(await this.ensure(), q, limit);
  }

  async semantic(q: string, opts: Parameters<typeof semanticRank>[2] = {}): Promise<SemanticResult> {
    return semanticRank(await this.ensure(), q, opts);
  }

  byId(claudeSessionId: string): SearchEntry | null {
    return this.index?.find((e) => e.claude_session_id === claudeSessionId) || null;
  }
}
