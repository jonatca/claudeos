/**
 * Real-transcript sampler. Scans the operator's REAL ~/.claude/projects/**.jsonl,
 * runs the CURRENT detectState over a sample of the most-recently-active ones, and
 * writes CANDIDATE GoldCases to src/eval/goldset/pending-review.json with the
 * predicted state as a PROPOSED (untrusted) label plus the detector's reason.
 *
 * IMPORTANT: these are CANDIDATES, not goldset truth. A human (the operator) must
 * confirm/correct each proposed label before it counts. They live in a SEPARATE file
 * (pending-review.json) and are never auto-promoted into state.json / triage.json.
 *
 * Run:  npm run eval:sample   (build + run)   |   node dist/eval/sample-real.js
 *
 * NOTE: a "second opinion" disagreement flag (a stronger model re-judging each case)
 * would require live `claude -p` calls, so it is intentionally stubbed/off here — see
 * the TODO below. The proposed labels are the cheap deterministic detector only.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseTranscript } from "../core/transcript";
import { detectState } from "../core/stateDetector";

const SAMPLE = Number(process.env.COCKPIT_EVAL_SAMPLE || 25); // how many recent transcripts to sample
const QUIET_MS = 4000;

interface Candidate {
  id: string;
  description: string;
  transcript_path: string;
  transcript: any[];
  processAlive: boolean;
  msSinceWrite: number;
  quietPeriodMs: number;
  changedLines: number;
  proposed: { state: string; reason: string };
  expected: null; // a human must fill this in to promote the case
  source: "real";
  reviewed: false;
}

/** Read just the TAIL of a (possibly huge) transcript so we keep the last few turns. */
function tailLines(file: string, bytes = 96 * 1024): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(Number(len));
    fs.readSync(fd, buf, 0, Number(len), start);
    let raw = buf.toString("utf8");
    if (start > 0) { const nl = raw.indexOf("\n"); if (nl >= 0) raw = raw.slice(nl + 1); }
    return raw.split("\n").filter((l) => l.trim());
  } finally { fs.closeSync(fd); }
}

/** Keep the last few user/assistant message lines as the candidate transcript (small + realistic). */
function condense(lines: string[], keep = 6): any[] {
  const msgs: any[] = [];
  for (const l of lines) {
    if (l.length > 80_000) continue;
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (!o.message) continue;
    msgs.push({ type: o.type, timestamp: o.timestamp ?? null, message: o.message });
  }
  return msgs.slice(-keep);
}

function main() {
  const projects = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projects)) {
    console.log(`No ~/.claude/projects found (${projects}) — nothing to sample.`);
    fs.writeFileSync(outPath(), JSON.stringify({ generated: new Date().toISOString(), note: "human review required before any of these count", candidates: [] }, null, 2) + "\n");
    return;
  }

  const files: { file: string; mtimeMs: number }[] = [];
  for (const dir of fs.readdirSync(projects)) {
    const dpath = path.join(projects, dir);
    let st: fs.Stats; try { st = fs.statSync(dpath); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dpath)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dpath, f);
      try { files.push({ file: fp, mtimeMs: fs.statSync(fp).mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sample = files.slice(0, SAMPLE);

  const candidates: Candidate[] = [];
  const dist: Record<string, number> = {};
  for (const { file, mtimeMs } of sample) {
    let view; try { view = parseTranscript(file); } catch { continue; }
    if (!view.turns.length) continue;
    const msSinceWrite = Math.max(0, Date.now() - mtimeMs);
    // processAlive: we don't probe /proc here (sampler is meant to be cheap + side-effect-free).
    // Use false; the operator confirms the label, and recency below is informational only.
    const det = detectState({ view, processAlive: false, msSinceWrite, quietPeriodMs: QUIET_MS });
    dist[det.state] = (dist[det.state] || 0) + 1;
    candidates.push({
      id: "real-" + path.basename(file).replace(/\.jsonl$/, "").slice(0, 12),
      description: (view.lastAssistant?.text || view.lastMeaningful?.text || "").replace(/\s+/g, " ").slice(0, 120),
      transcript_path: file,
      transcript: condense(tailLines(file)),
      processAlive: false,
      msSinceWrite,
      quietPeriodMs: QUIET_MS,
      changedLines: 0, // unknown without a worktree diff; operator fills in for triage cases
      proposed: { state: det.state, reason: det.reason },
      expected: null,
      source: "real",
      reviewed: false,
    });
  }

  const payload = {
    generated: new Date().toISOString(),
    note: "CANDIDATES ONLY — a human must set `expected` and `reviewed:true` before any case is promoted into state.json/triage.json. `proposed` is the current detector's guess, not ground truth.",
    // TODO(second-opinion): re-judge each candidate with a stronger model to flag
    // disagreements. Requires live `claude -p` — intentionally skipped offline.
    second_opinion: "disabled (needs live claude -p)",
    sampled: sample.length,
    proposed_state_distribution: dist,
    candidates,
  };
  fs.writeFileSync(outPath(), JSON.stringify(payload, null, 2) + "\n");

  console.log(`Sampled ${sample.length} recent transcript(s) from ${projects}`);
  console.log("Proposed state distribution:", JSON.stringify(dist));
  console.log(`Wrote ${candidates.length} CANDIDATE case(s) -> ${outPath()}`);
  console.log("These are UNREVIEWED. A human must confirm/correct each `proposed` label before it counts.");
}

function outPath(): string {
  return path.resolve(__dirname, "../../src/eval/goldset/pending-review.json");
}

main();
