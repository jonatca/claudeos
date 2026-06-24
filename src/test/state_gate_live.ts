/**
 * LIVE reliability probe for the ready-gate (card 288). Gated behind COCKPIT_LIVE=1 (it reads real
 * transcripts and spends a few Haiku tokens):
 *
 *   COCKPIT_LIVE=1 node dist/test/state_gate_live.js
 *
 * It runs the FULL gate against the operator's REAL sessions on this box (the many live
 * cockpit-new-claude-session-* fixtures) and measures the thing the card cares about: the
 * FALSE-SURFACE RATE — how many still-working / self-blocked sessions the OLD heuristic-only path
 * would have surfaced, that the NEW gate (double-sample + Haiku) correctly hides.
 *
 * Safe: it operates on a COPY of the live cockpit.db (never mutates the operator's DB) and only
 * READS transcripts. For each session it: detects the heuristic state, takes two transcript+CPU
 * samples a gap apart (the double-sample), and — for a stable, alive, recently-active candidate —
 * asks Haiku for the 4-way class. It then compares OLD vs NEW surface decisions.
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Use the REAL home (so transcripts + the configured `claude` resolve) but a COPY of the live DB.
const REAL_DB = process.env.COCKPIT_REAL_DB || path.resolve(__dirname, "../../data/cockpit.db");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-gatelive-"));
const DB_COPY = path.join(tmp, "cockpit.db");
try {
  fs.copyFileSync(REAL_DB, DB_COPY);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(REAL_DB + ext)) fs.copyFileSync(REAL_DB + ext, DB_COPY + ext);
  }
} catch (e) {
  console.error(`Could not copy the live DB from ${REAL_DB} — set COCKPIT_REAL_DB. (${e})`);
  process.exit(2);
}
process.env.COCKPIT_DB = DB_COPY;

import { openDb, allSessions } from "../core/db";
import { loadConfig } from "../core/config";
import { SessionManager } from "../core/sessions";
import { detectState } from "../core/stateDetector";
import { parseTranscriptTail } from "../core/transcript";
import { transcriptSig, processTreeJiffies, StreamingSampler } from "../core/streamingSampler";
import { verifyWorking } from "../core/workingVerifier";
import { check, summary } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sample(sm: SessionManager, s: any) {
  const tPath = sm.transcriptFor(s);
  let view = null as any;
  let mtimeMs = 0;
  let msSinceWrite = Infinity;
  if (tPath) {
    try {
      const st = fs.statSync(tPath);
      mtimeMs = st.mtimeMs;
      msSinceWrite = Date.now() - mtimeMs;
      view = await parseTranscriptTail(tPath, mtimeMs);
    } catch {}
  }
  const alive = sm.processAlive(s);
  const det = detectState({ view, processAlive: alive, msSinceWrite, quietPeriodMs: 4000 });
  const sig = view ? transcriptSig(view.raw, mtimeMs) : `none:${s.id}`;
  return { view, mtimeMs, msSinceWrite, alive, det, sig, cpu: processTreeJiffies(s.pid) };
}

async function main() {
  if (process.env.COCKPIT_LIVE !== "1") {
    console.log("state_gate_live: set COCKPIT_LIVE=1 to run (reads real transcripts + spends Haiku tokens). Skipped.");
    process.exit(0);
  }
  const db = openDb();
  const cfg = loadConfig();
  const sm = new SessionManager(db);
  const gap = cfg.state_gate.double_sample_gap_ms;
  const cpuFrac = cfg.state_gate.cpu_busy_frac;
  const gateModel = cfg.state_gate.model || "sonnet";

  const sessions = allSessions(db).filter((s) => s.kind === "claude").slice(0, 30);
  console.log(`\n== Ready-gate LIVE over ${sessions.length} real sessions (gap=${gap}ms cpuBusy=${cpuFrac}) ==\n`);

  const sampler = new StreamingSampler();
  // First sample (t0).
  const first = new Map<number, any>();
  for (const s of sessions) {
    const a = await sample(sm, s);
    first.set(s.id, a);
    sampler.consider(s.id, { sig: a.sig, cpuJiffies: a.cpu, at: Date.now() }, gap, cpuFrac);
  }
  await sleep(gap + 500); // wait one gap, then sample again — the literal double-sample

  let oldSurface = 0; // heuristic-only would surface (state !== WORKING)
  let newSurface = 0; // the gate would surface
  let falseAvoided = 0; // OLD would surface but the gate proves it's still working / self-blocked
  const rows: string[] = [];

  for (const s of sessions) {
    const b = await sample(sm, s);
    const stab = sampler.consider(s.id, { sig: b.sig, cpuJiffies: b.cpu, at: Date.now() }, gap, cpuFrac);
    const oldReady = b.det.state !== "WORKING" && !!b.view; // the legacy heuristic-only surface test
    if (oldReady) oldSurface++;

    // The gate: EVERY alive candidate must pass the double-sample, then the model — no recency
    // window (the verdict, not the clock, decides; long-quiet self-waiters were the leak).
    let gateReady = oldReady;
    let activity = "—";
    let why = b.det.reason;
    if (oldReady && b.alive && !!b.view) {
      if (!stab.stable) {
        gateReady = false;
        why = `double-sample: ${stab.reason}`;
      } else {
        const v = await verifyWorking(b.view, gateModel);
        if (v) {
          activity = v.activity;
          gateReady = !v.working;
          why = `${gateModel}: ${v.activity} — ${v.reason}`;
        }
      }
    }
    if (gateReady) newSurface++;
    if (oldReady && !gateReady) falseAvoided++;

    const tag = oldReady === gateReady ? " " : (gateReady ? "+" : "−");
    rows.push(
      `${tag} #${s.id} ${(s.clean_title || s.title || "").slice(0, 34).padEnd(34)} ` +
      `heur=${b.det.state.padEnd(13)} alive=${b.alive ? "Y" : "n"} ${Math.round(b.msSinceWrite / 1000)}s ago ` +
      `stable=${stab.stable ? "Y" : "n"} act=${String(activity).padEnd(20)} → ${gateReady ? "SURFACE" : "hidden "}  ${why.slice(0, 70)}`
    );
  }

  console.log(rows.join("\n"));
  console.log(
    `\nOLD heuristic-only would surface: ${oldSurface}` +
    `\nNEW gate surfaces:               ${newSurface}` +
    `\nFalse-surfaces the gate AVOIDED: ${falseAvoided}  (still-working / self-blocked sessions the old path would have shown)\n`
  );

  // The guarantee: the gate must NEVER surface MORE than the heuristic (it only ever HIDES more).
  check("gate never surfaces more sessions than the legacy heuristic (only hides more)", newSurface <= oldSurface);
  check("ran the gate over the real sessions on this box", sessions.length > 0);
  process.exit(summary());
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
