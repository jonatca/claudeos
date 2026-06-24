/**
 * streamingSampler.ts — the DOUBLE-SAMPLE output-stability gate (Layer 1 of the ready-gate).
 *
 * THE GUARANTEE this enforces: a session never enters Up Next while it is still OUTPUTTING TOKENS
 * or otherwise actively computing. The transcript `.jsonl` is written per COMPLETED message (not
 * per token), so a single tail-read can look "finished" mid-reply — the last completed message
 * reads like a question/done while more is still coming. The fix is to SAMPLE TWICE a gap apart and
 * only treat a session as eligible-to-surface when it has been genuinely QUIET across that gap.
 *
 * Two independent "still active" signals are combined (either one ⇒ NOT stable ⇒ keep hidden):
 *   1. Transcript motion — a signature of the transcript END (mtime + byte-length + tail hash).
 *      Any newly-written token changes it. Computed FREE from the 128KB tail the tick already read.
 *   2. Process CPU burn — utime+stime jiffies of the session's process tree. Research (claudectl)
 *      found CPU is the single strongest "is it working?" signal: a session can be mid-COMPUTE with
 *      a momentarily-static transcript (thinking between messages, a tool running that hasn't
 *      written yet). >cpu_busy_frac CPU since the last sample ⇒ still working. Best-effort: null
 *      (no /proc, unknown pid) simply falls back to the transcript signal.
 *
 * This is FREE (no model call) and runs BEFORE the Haiku classifier so we never pay to classify a
 * session that is visibly still moving. It rides the existing ~5s engine tick: consecutive ticks
 * provide the two samples, no extra timers. See engine._tick (the reverse/surface guard).
 *
 * Sources folded in: claudectl (CPU as the strongest signal; permission prompts leave no transcript
 * trace) https://mercurialsolo.github.io/posts/claudectl-tui-dashboard/ ; primeline tmux
 * orchestration (double-sample the output, compare for change)
 * https://github.com/primeline-ai/claude-tmux-orchestration . We sample the TRANSCRIPT (already
 * ANSI-free, structured) rather than scraping the pane, which is more robust than capture-pane.
 */
import * as fs from "fs";
import * as crypto from "crypto";

/** Linux USER_HZ — jiffies per second in /proc/<pid>/stat utime+stime. 100 on the operator's box
 *  (and effectively every modern x86 Linux). Only used to turn a jiffie delta into a CPU fraction. */
const CLK_TCK = 100;

export interface Sample {
  sig: string;               // transcript signature — changes on ANY newly-written token
  cpuJiffies: number | null; // utime+stime of the session's process tree, or null if unknown
  at: number;                // wall-clock ms this sample was taken
}

export interface StabilityResult {
  stable: boolean; // true = transcript byte-stable AND process not CPU-busy for >= the gap
  changed: boolean; // true = a positive "still active" signal fired (transcript grew / CPU busy)
  reason: string;
}

/** Signature of the current transcript END — FREE, from data already in hand (the 128KB tail). Any
 *  newly-written token changes either the mtime, the byte length, or the hash, so two EQUAL sigs a
 *  gap apart prove the transcript did not move in between. */
export function transcriptSig(tailRaw: string, mtimeMs: number): string {
  const h = crypto.createHash("sha1").update(tailRaw).digest("hex").slice(0, 16);
  return `${Math.round(mtimeMs)}:${tailRaw.length}:${h}`;
}

// A short-TTL snapshot of /proc so many candidate sessions in ONE tick share a single scan instead
// of re-reading /proc per session. (The map is pid -> {ppid, jiffies}.)
let _procSnap: { at: number; map: Map<number, { ppid: number; j: number }> } | null = null;
function procSnapshot(now: number): Map<number, { ppid: number; j: number }> {
  if (_procSnap && now - _procSnap.at < 800) return _procSnap.map;
  const map = new Map<number, { ppid: number; j: number }>();
  try {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        // The comm (field 2) is wrapped in parens and may itself contain spaces/parens, so parse
        // everything AFTER the last ')'. Then fields are: state(0) ppid(1) ... utime(11) stime(12).
        const rp = stat.lastIndexOf(")");
        if (rp < 0) continue;
        const rest = stat.slice(rp + 2).split(" ");
        const ppid = parseInt(rest[1], 10);
        const utime = parseInt(rest[11], 10);
        const stime = parseInt(rest[12], 10);
        if (Number.isFinite(ppid) && Number.isFinite(utime) && Number.isFinite(stime))
          map.set(parseInt(name, 10), { ppid, j: utime + stime });
      } catch {
        /* a process that vanished mid-scan — skip it */
      }
    }
  } catch {
    /* no /proc (non-Linux) → CPU signal simply unavailable */
  }
  _procSnap = { at: now, map };
  return map;
}

/** Sum utime+stime jiffies of `pid` AND all its descendants (the session's pane shell + the real
 *  `claude` child under it). Returns null when the pid is unknown or /proc isn't readable, so the
 *  caller degrades cleanly to the transcript-only signal. */
export function processTreeJiffies(pid: number | null | undefined, now = Date.now()): number | null {
  if (!pid) return null;
  const map = procSnapshot(now);
  if (!map.has(pid)) return null;
  const children = new Map<number, number[]>();
  for (const [p, v] of map) {
    const arr = children.get(v.ppid);
    if (arr) arr.push(p);
    else children.set(v.ppid, [p]);
  }
  let total = 0;
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    const v = map.get(p);
    if (v) total += v.j;
    for (const c of children.get(p) || []) stack.push(c);
  }
  return total;
}

/**
 * The double-sample gate. Keeps the LAST sample per session; each new sample decides whether the
 * session has been CONTINUOUSLY QUIET — transcript unchanged AND not CPU-busy — for at least
 * `gapMs`. A single change (new tokens or a CPU burst) resets the quiet timer. Only a `stable`
 * session is eligible to be surfaced; anything still moving is "still working", kept hidden.
 */
export class StreamingSampler {
  private last = new Map<number, Sample>();

  consider(id: number, cur: Sample, gapMs: number, cpuBusyFrac: number): StabilityResult {
    const prev = this.last.get(id);
    if (!prev) {
      this.last.set(id, cur);
      return { stable: false, changed: false, reason: "first sample — waiting one gap to confirm it stopped" };
    }
    const elapsed = cur.at - prev.at;
    // Signal 1: transcript moved → new tokens were written → still streaming.
    if (cur.sig !== prev.sig) {
      this.last.set(id, cur); // reset the quiet timer to NOW
      return { stable: false, changed: true, reason: "transcript grew across the double-sample — still streaming" };
    }
    // Signal 2: transcript static, but the process burned CPU since the baseline → still computing.
    if (prev.cpuJiffies != null && cur.cpuJiffies != null && elapsed > 0) {
      const frac = (cur.cpuJiffies - prev.cpuJiffies) / ((elapsed / 1000) * CLK_TCK);
      if (frac >= cpuBusyFrac) {
        this.last.set(id, cur); // reset the quiet timer
        return { stable: false, changed: true, reason: `process still burning CPU (~${Math.round(frac * 100)}%) — computing` };
      }
    }
    // Quiet on both signals. Only STABLE once the quiet has lasted at least the gap. (Keep `prev`
    // so the elapsed quiet keeps accumulating across ticks; the next write flips the sig and resets.)
    if (elapsed >= gapMs) {
      return { stable: true, changed: false, reason: `transcript byte-stable + process quiet for ${Math.round(elapsed)}ms (≥ ${gapMs}ms gap)` };
    }
    return { stable: false, changed: false, reason: `quiet but only ${Math.round(elapsed)}ms of the ${gapMs}ms gap elapsed` };
  }

  /** Drop a session's sample history (e.g. once it has surfaced, or been removed). */
  forget(id: number): void {
    this.last.delete(id);
  }
}
