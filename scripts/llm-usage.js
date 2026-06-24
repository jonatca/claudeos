/**
 * LLM usage report — answers "how much of my Claude subscription does ClaudeOS drain,
 * and which part of it?" from the per-call ledger .run/llm-usage.jsonl (written by
 * src/core/claude.ts on every `claude -p` call).
 *
 * Run:  node scripts/llm-usage.js [hours]      (default: last 24h)
 *
 * cost_usd is the CLI-reported API-EQUIVALENT price — on a subscription nothing is
 * billed per call; treat it as a relative "rate-limit weight" between labels.
 */
const fs = require("fs");
const path = require("path");

const hours = Number(process.argv[2] || 24);
const cutoff = Date.now() - hours * 3600e3;
const file = path.resolve(__dirname, "../.run/llm-usage.jsonl");
if (!fs.existsSync(file)) {
  console.log(`no ledger yet (${file}) — it appears after the first model call of a deployed server.`);
  process.exit(0);
}

const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter((r) => r && Date.parse(r.ts) >= cutoff);

const by = {};
for (const r of rows) {
  const k = `${r.label}/${r.model}`;
  const b = (by[k] ||= { calls: 0, errors: 0, timeouts: 0, in: 0, cache_w: 0, cache_r: 0, out: 0, cost: 0, ms: 0 });
  b.calls++;
  if (r.error) b.errors++;
  if (r.timeout) b.timeouts++;
  b.in += r.in || 0; b.cache_w += r.cache_w || 0; b.cache_r += r.cache_r || 0; b.out += r.out || 0;
  b.cost += r.cost_usd || 0; b.ms += r.ms || 0;
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const keys = Object.keys(by).sort((a, b2) => by[b2].cost - by[a].cost);
const total = { calls: 0, cost: 0, cache_w: 0, cache_r: 0, out: 0 };

console.log(`\nLLM usage — last ${hours}h (${rows.length} calls)   [cost = API-equivalent $, i.e. rate-limit weight]\n`);
console.log("label/model".padEnd(28) + "calls".padStart(7) + "new-tok".padStart(10) + "cached".padStart(10) + "out".padStart(8) + "~$".padStart(9) + "avg ms".padStart(9) + "  err/to");
for (const k of keys) {
  const b = by[k];
  total.calls += b.calls; total.cost += b.cost; total.cache_w += b.cache_w; total.cache_r += b.cache_r; total.out += b.out;
  console.log(
    k.padEnd(28) + String(b.calls).padStart(7) + fmt(b.in + b.cache_w).padStart(10) + fmt(b.cache_r).padStart(10) +
    fmt(b.out).padStart(8) + b.cost.toFixed(2).padStart(9) + String(Math.round(b.ms / Math.max(1, b.calls))).padStart(9) +
    `  ${b.errors}/${b.timeouts}`
  );
}
console.log("-".repeat(88));
console.log("TOTAL".padEnd(28) + String(total.calls).padStart(7) + fmt(total.cache_w).padStart(10) + fmt(total.cache_r).padStart(10) + fmt(total.out).padStart(8) + total.cost.toFixed(2).padStart(9));
console.log(`\nper hour: ${(total.calls / hours).toFixed(1)} calls · ~$${(total.cost / hours).toFixed(2)} API-equivalent\n`);
