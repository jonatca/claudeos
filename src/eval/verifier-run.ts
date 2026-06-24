/**
 * Verifier eval — measures the Layer-2 classifier (workingVerifier.classifierPrompt)
 * against the LIVE model on a labeled goldset of REAL transcript tails
 * (src/eval/goldset/verifier.json, built by scripts/build-verifier-goldset.js).
 *
 * This is the "does the task queue lie to the operator?" metric:
 *   - FALSE SURFACE: a case labeled hide (WORKING / WAITING_ON_SELF — outputting
 *     tokens or waiting on its own script) that the model classifies as
 *     surfaceable. THE failure mode this whole gate exists to prevent. Gate: 0.
 *   - FALSE HIDE: a case labeled surface (a real question / a finished report)
 *     classified as hidden — the operator never sees a session that needs them.
 *     Gate: 0.
 *   - Class accuracy: exact 4-way agreement (reported, not gated — DONE vs
 *     WAITING_ON_OPERATOR confusion changes priority, not visibility).
 *
 * Run:  npm run eval:verifier                      (haiku, the production model)
 *       COCKPIT_VERIFIER_MODEL=sonnet npm run eval:verifier
 *       COCKPIT_VERIFIER_REPEATS=3 ...             (stochasticity check: every
 *                                                   repeat must individually pass)
 *
 * Spends real model calls (one `claude -p` per case per repeat, ~2-4s each,
 * concurrency-limited). NOT part of `npm test` / the pre-push gate — run it when
 * touching classifierPrompt or the gate model.
 */
import * as fs from "fs";
import * as path from "path";
import { classifierPrompt, parseVerdict, verifierTail, ActivityClass, WorkingVerdict } from "../core/workingVerifier";
import { claudeJson } from "../core/claude";

interface VerifierCase {
  id: string;
  description: string;
  expected: ActivityClass;
  surface: boolean;
  source: "real" | "synthetic";
  file?: string;
  tail: string;
}

const MODEL = process.env.COCKPIT_VERIFIER_MODEL || "haiku";
const REPEATS = Math.max(1, Number(process.env.COCKPIT_VERIFIER_REPEATS || 1));
const CONCURRENCY = 6;
const surfaces = (v: WorkingVerdict | null) => !!v && !v.working; // null = model failure = stays hidden (conservative)

const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", dim: "\x1b[2m", b: "\x1b[1m", reset: "\x1b[0m" };

async function main(): Promise<number> {
  // Real harvested transcripts (verifier.json) are gitignored — they contain real
  // operator session tails and never sync to GitHub. Fall back to the tracked
  // neutral synthetic set (verifier.sample.json) so a fresh clone can still run.
  const realFile = path.resolve(__dirname, "../../src/eval/goldset/verifier.json");
  const sampleFile = path.resolve(__dirname, "../../src/eval/goldset/verifier.sample.json");
  const file = fs.existsSync(realFile) ? realFile : sampleFile;
  if (file === sampleFile) console.log(`${C.y}(verifier.json not present — using tracked synthetic verifier.sample.json)${C.reset}`);
  const cases = JSON.parse(fs.readFileSync(file, "utf8")) as VerifierCase[];

  // one work item per (case, repeat)
  const work: { c: VerifierCase; rep: number }[] = [];
  for (const c of cases) for (let r = 0; r < REPEATS; r++) work.push({ c, rep: r });

  const results = new Map<string, (WorkingVerdict | null)[]>(); // case id -> verdicts per repeat
  for (const c of cases) results.set(c.id, []);

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= work.length) return;
      const { c } = work[i];
      const j = await claudeJson<{ state: string; reason: string }>(classifierPrompt(verifierTail(c.tail)), { model: MODEL, timeoutMs: 60000 });
      results.get(c.id)!.push(parseVerdict(j));
      process.stderr.write(".");
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write("\n");

  // ---- score: every repeat must individually be safe; class accuracy over all repeats ----
  let classHits = 0, surfaceHits = 0, total = 0;
  const falseSurfaces: string[] = [];
  const falseHides: string[] = [];
  const rows: any[] = [];
  for (const c of cases) {
    const vs = results.get(c.id)!;
    const preds = vs.map((v) => (v ? v.activity : "NULL"));
    for (const v of vs) {
      total++;
      const act = v ? v.activity : "NULL";
      if (act === c.expected) classHits++;
      const pSurf = surfaces(v);
      if (pSurf === c.surface) surfaceHits++;
      if (!c.surface && pSurf) falseSurfaces.push(`${c.id}: expected ${c.expected} (hide) → got ${act} (surfaces) — "${v?.reason}"`);
      if (c.surface && !pSurf) falseHides.push(`${c.id}: expected ${c.expected} (surface) → got ${act} (hidden) — "${v?.reason}"`);
    }
    rows.push({ id: c.id, source: c.source, expected: c.expected, surface: c.surface, predicted: preds, reasons: vs.map((v) => v?.reason ?? null) });
    const uniq = [...new Set(preds)];
    const ok = uniq.length === 1 && uniq[0] === c.expected;
    const safe = vs.every((v) => surfaces(v) === c.surface);
    const mark = ok ? C.g + "✓" : safe ? C.y + "≈" : C.r + "✗";
    console.log(`  ${mark}${C.reset} ${c.id.padEnd(28)} want ${c.expected.padEnd(20)} got ${preds.join(",")}`);
  }

  const classAcc = classHits / total;
  const surfAcc = surfaceHits / total;
  console.log(`\n${C.b}== verifier eval · model=${MODEL} · repeats=${REPEATS} · ${cases.length} cases · ${((Date.now() - t0) / 1000).toFixed(0)}s ==${C.reset}`);
  console.log(`class accuracy   : ${(classAcc * 100).toFixed(1)}%  (${classHits}/${total})`);
  console.log(`surface accuracy : ${(surfAcc * 100).toFixed(1)}%  (${surfaceHits}/${total})`);
  const fsCol = falseSurfaces.length ? C.r : C.g;
  const fhCol = falseHides.length ? C.r : C.g;
  console.log(`${fsCol}FALSE SURFACES (working/self-waiting shown to operator): ${falseSurfaces.length}${C.reset}`);
  for (const f of falseSurfaces) console.log(`${C.r}    - ${f}${C.reset}`);
  console.log(`${fhCol}FALSE HIDES   (question/done hidden from operator)     : ${falseHides.length}${C.reset}`);
  for (const f of falseHides) console.log(`${C.r}    - ${f}${C.reset}`);

  const resDir = path.resolve(__dirname, "../../src/eval/results");
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(
    path.join(resDir, `verifier-${MODEL}.json`),
    JSON.stringify({ timestamp: new Date().toISOString(), model: MODEL, repeats: REPEATS,
      class_accuracy: Number(classAcc.toFixed(4)), surface_accuracy: Number(surfAcc.toFixed(4)),
      false_surfaces: falseSurfaces, false_hides: falseHides, rows }, null, 2) + "\n"
  );

  const ok = falseSurfaces.length === 0 && falseHides.length === 0;
  console.log(ok ? `\n${C.g}${C.b}  VERIFIER EVAL GREEN${C.reset}\n` : `\n${C.r}${C.b}  VERIFIER EVAL RED${C.reset}\n`);
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code));
