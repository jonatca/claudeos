/**
 * Kanban backfill — when the operator has too few real things to work on, proactively
 * surface the top cards from their kanban board (~/kanban) as items so the
 * cockpit is never idle. Each card is classified (haiku) STARTABLE vs NEEDS-INFO:
 *   - STARTABLE  -> a "start" action launches a real Claude Code session for it.
 *   - NEEDS-INFO -> shows clarifying questions; answers can (on explicit confirm) be
 *                   appended to the kanban file. NEVER writes the file without confirm.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { claudeJson } from "./claude";

/** FIX J: move a kanban card .md into `toDir` (e.g. 8_done). The board is an NFS mount with a
 *  primary-gid quirk, so we move via `sg managers -c "mv …"` (per the repo's kanban rule); falls
 *  back to a plain rename when `sg` isn't available (tests / non-NFS). Guards: source must exist,
 *  never clobbers an existing destination. Returns the new path, or null if it couldn't move. */
export function moveCardFile(fromPath: string, toDir: string): string | null {
  try { if (!fromPath || !fs.existsSync(fromPath)) return null; } catch { return null; }
  const dest = path.join(toDir, path.basename(fromPath));
  try { if (fs.existsSync(dest)) return null; } catch {}
  try { fs.mkdirSync(toDir, { recursive: true }); } catch {}
  try {
    execFileSync("sg", ["managers", "-c", `mv ${JSON.stringify(fromPath)} ${JSON.stringify(dest)}`], { stdio: "ignore" });
  } catch {
    /* sg missing/failed → fall through to plain rename */
  }
  try { if (!fs.existsSync(dest) && fs.existsSync(fromPath)) fs.renameSync(fromPath, dest); } catch {}
  try { return fs.existsSync(dest) ? dest : null; } catch { return null; }
}

/** FIX J: best-effort find a kanban card whose title matches a session title, across all column
 *  folders under `kanbanRoot`. Returns the card's full path + column, or null. Matches on the
 *  slugified title (exact, or one is a long substring of the other). */
export function findCardByTitle(kanbanRoot: string, title: string): { fullPath: string; column: string } | null {
  const want = slugifyTitle(title);
  if (!want || want.length < 6) return null;
  let cols: string[] = [];
  try { cols = fs.readdirSync(kanbanRoot).filter((d) => /^\d/.test(d)); } catch { return null; }
  let best: { fullPath: string; column: string; score: number } | null = null;
  for (const col of cols) {
    const dir = path.join(kanbanRoot, col);
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      const parsed = parseKanbanFilename(f);
      if (!parsed) continue;
      const cand = slugifyTitle(parsed.title);
      if (!cand) continue;
      let score = 0;
      if (cand === want) score = 100;
      else if (cand.includes(want) || want.includes(cand)) score = Math.min(cand.length, want.length);
      if (score >= 8 && (!best || score > best.score)) best = { fullPath: path.join(dir, f), column: col, score };
    }
  }
  return best ? { fullPath: best.fullPath, column: best.column } : null;
}

function slugifyTitle(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface KanbanCard {
  key: string; // synthetic stable id: kanban:<column>/<file>
  column: string;
  columnRank: number; // index in the configured column order (0 = highest)
  file: string;
  fullPath: string;
  priority: number; // filename NN (higher = more urgent)
  complexity: number; // cN
  humanRequired: boolean;
  aiReady: boolean; // '#'-prefixed
  title: string;
  body: string;
}

/** Parse a kanban filename: [#]NN-c<comp>[H]-kebab-title.md */
export function parseKanbanFilename(file: string): {
  priority: number;
  complexity: number;
  humanRequired: boolean;
  aiReady: boolean;
  title: string;
} | null {
  if (!file.endsWith(".md")) return null;
  const name = file.slice(0, -3);
  const m = name.match(/^(#?)(\d{1,3})-c(\d)([A-Za-z]*)-(.+)$/);
  if (!m) return null;
  const aiReady = m[1] === "#";
  const priority = parseInt(m[2], 10);
  const complexity = parseInt(m[3], 10);
  const flags = (m[4] || "").toUpperCase();
  const humanRequired = flags.includes("H");
  const title = m[5].replace(/-/g, " ").replace(/\s+/g, " ").trim();
  return { priority, complexity, humanRequired, aiReady, title };
}

/** Read + parse all candidate cards from the configured columns, best-first. */
export function listKanbanCards(kanbanPath: string, columnOrder: string[]): KanbanCard[] {
  const cards: KanbanCard[] = [];
  columnOrder.forEach((column, columnRank) => {
    const dir = path.join(kanbanPath, column);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      const parsed = parseKanbanFilename(file);
      if (!parsed) continue;
      // H (human-required) cards are NOT skipped and get no special treatment downstream:
      // they classify, start, and auto-launch like any other card (the flag is informational).
      const fullPath = path.join(dir, file);
      let body = "";
      try {
        body = fs.readFileSync(fullPath, "utf8");
      } catch {}
      cards.push({
        key: `kanban:${column}/${file}`,
        column,
        columnRank,
        file,
        fullPath,
        priority: parsed.priority,
        complexity: parsed.complexity,
        humanRequired: parsed.humanRequired,
        aiReady: parsed.aiReady,
        title: parsed.title,
        body,
      });
    }
  });
  // sort by column rank (asc), then filename priority (desc)
  cards.sort((a, b) => a.columnRank - b.columnRank || b.priority - a.priority);
  return cards;
}

/** Strip the markdown card to its description text for the LLM / display. */
export function cardDescription(body: string): string {
  // body is usually "# Title\n\n---\n\n<desc>"; return the part after the first '---'
  const idx = body.indexOf("---");
  const desc = idx >= 0 ? body.slice(idx + 3) : body;
  return desc.replace(/^#.*$/m, "").trim();
}

export interface KanbanClassification {
  startable: boolean;
  questions: string[]; // 2-5 clarifying questions when NEEDS-INFO
  fromScratch?: boolean; // true = so sparse we can't even form questions → "explain from scratch"
}

/**
 * Classify a card STARTABLE vs NEEDS-INFO. '#'-prefixed (AI-ready) cards are startable
 * without an LLM call. Otherwise ask haiku; on failure default to NEEDS-INFO with a
 * generic question (safe: never auto-starts on uncertainty).
 */
export async function classifyKanbanCard(
  card: { title: string; body: string; aiReady: boolean; complexity: number },
  model: string,
  classifier?: (card: any, model: string) => Promise<KanbanClassification | null>
): Promise<KanbanClassification> {
  if (card.aiReady) return { startable: true, questions: [] };
  if (classifier) {
    const r = await classifier(card, model);
    if (r) return r;
  }
  const desc = cardDescription(card.body);
  const j = await claudeJson<{ startable: boolean; questions: string[] }>(
    `You are triaging a kanban task card for an autonomous coding agent (Claude Code).
Decide if there is ENOUGH information to START the task without asking the human first.
Return JSON: { "startable": boolean, "questions": string[] }.
- startable=true if the card clearly describes what to do and an agent could begin.
- startable=false if key details are missing; then provide 2-5 specific clarifying questions.
Title: ${card.title}
Body:
"""${desc.slice(0, 3000)}"""`,
    { model, timeoutMs: 60000, label: "kanban" }
  );
  if (!j || typeof j.startable !== "boolean") {
    // Couldn't classify at all → too sparse to even form targeted questions: "explain from scratch".
    return { startable: false, fromScratch: true, questions: ["What exactly is the desired outcome?", "Which files/repo/area does this touch?"] };
  }
  const questions = Array.isArray(j.questions) ? j.questions.filter((q) => typeof q === "string" && q.trim()).slice(0, 5) : [];
  if (!j.startable && !questions.length) {
    // NEEDS-INFO but the model produced no usable questions → "explain from scratch".
    return { startable: false, fromScratch: true, questions: ["What is the acceptance criterion?"] };
  }
  return { startable: j.startable, questions: j.startable ? [] : questions };
}

/** The boot prompt for a launched kanban-card session — SHARED by the engine auto-launch
 *  (launchKanbanCard) and the terminal-open materialization (controller), so every start path
 *  says the same thing. It is a single-line `/work <number> <title> (in <column>)` invocation
 *  (operator decision 2026-06-11): the repo's own /work skill drives everything — card move to
 *  5_in_progress, repo-indicator mapping, task worktree+branch, tmux @claude_task naming —
 *  exactly like the operator typing it into a Ctrl+G i session. The title + column ride along
 *  to disambiguate duplicate priority numbers and cards outside _work/4_today. MUST stay one
 *  line: a multi-line message would not parse as a slash command.
 *
 *  Any saved-but-unappended operator answers are flushed to the card file here (launching
 *  CONSUMES the card, so the confirm-gate for un-started cards no longer applies) — /work reads
 *  the card file, so this is how the answers reach the session. */
export function kanbanLaunchPrompt(session: {
  title: string;
  kanban_file?: string | null;
  kanban_column?: string | null;
  kanban_answers?: string | null;
}): string {
  let qa: { q: string; a: string }[] = [];
  try { qa = session.kanban_answers ? JSON.parse(session.kanban_answers) : []; } catch {}
  qa = (Array.isArray(qa) ? qa : []).filter((x: any) => x && x.a);
  if (qa.length && session.kanban_file) {
    try {
      if (fs.existsSync(session.kanban_file) && !fs.readFileSync(session.kanban_file, "utf8").includes(qa[0].a)) {
        appendAnswersToCard(session.kanban_file, qa);
      }
    } catch {}
  }
  const parsed = session.kanban_file ? parseKanbanFilename(path.basename(session.kanban_file)) : null;
  const column = session.kanban_column ? ` (in ${session.kanban_column})` : "";
  if (parsed) return `/work ${parsed.priority} ${session.title}${column}`;
  // No parsable card filename → /work can still find it by title words + column.
  return `/work ${session.title}${column}`;
}

/** Append the operator's clarifying answers to the kanban card file. CONFIRM-GATED. */
export function appendAnswersToCard(fullPath: string, qa: { q: string; a: string }[]): void {
  const block =
    "\n\n## Clarifications (added via Cockpit)\n\n" +
    qa.map(({ q, a }) => `**Q: ${q}**\n${a}`).join("\n\n") +
    "\n";
  fs.appendFileSync(fullPath, block);
}
