# ClaudeOS eval goldset

These JSON files are the **trusted, hand-labelled cases** the eval harness scores
the safety-critical core against. They are **data, not code**, so anyone can add a
case without touching TypeScript.

- `state.json` — cases for `detectState` (every `SessionState`: WORKING / WAITING_INPUT / DONE / UNKNOWN).
- `triage.json` — ready cases for `triageRules` (SIMPLE_QUESTION / REVIEW_DIFF / COMPLEX_DECISION / FYI_DONE).
- `verifier.sample.json` — small **neutral synthetic** seed for the verifier eval (tracked). Lets `npm run eval:verifier` run on a fresh clone with no real data.
- `pending-review.json` — **untrusted CANDIDATES** emitted by `npm run eval:sample` from real transcripts. A human must confirm/correct each `proposed` label and move it into `state.json`/`triage.json` before it counts. Never auto-promoted.

Run: `npm run eval` (scores state.json + triage.json) · `npm run eval:sample` (regenerates pending-review.json).

## Local-only files (gitignored — never synced to GitHub)

These contain **real operator/Claude session transcripts** (and historically a real
credential), so they are gitignored and live only on the machine that harvested them:

- `verifier.json` — real labelled transcript tails, built by `scripts/build-verifier-goldset.js`.
- `pending-review.json` — real sampled candidates (`npm run eval:sample`).
- `../results/verifier-*.{json,html}` — verifier run outputs over the real set.

`npm run eval:verifier` uses `verifier.json` when present, and **falls back to the
tracked `verifier.sample.json`** otherwise — so the eval works on a fresh clone. To run
it on real data, harvest your own via `node scripts/build-verifier-goldset.js` (writes
the gitignored `verifier.json`). The gated `npm run eval` (state + triage) needs none of
this and stays fully reproducible from the tracked synthetic files.

## Case format (`GoldCase`)

```jsonc
{
  "id": "waiting-should-i",              // unique, stable
  "description": "why this case exists / what it exercises",
  "transcript": [                         // RAW Claude Code transcript line objects (user/assistant)
    { "type": "assistant",
      "message": { "role": "assistant", "stop_reason": "end_turn",
        "content": [ { "type": "text", "text": "Should I bind to 8080?" } ] } }
  ],
  "processAlive": false,                  // is the claude process still running?
  "msSinceWrite": 99999,                  // ms since the transcript was last written
  "quietPeriodMs": 4000,                  // streaming window; recent write + alive => WORKING
  "changedLines": 0,                      // worktree diff size (only matters for triage)
  "expected": { "state": "WAITING_INPUT", "triage": "SIMPLE_QUESTION" },  // triage optional
  "source": "fixture"                     // "fixture" (authored) | "real" (sampled + confirmed)
}
```

The harness materializes `transcript` to a temp `.jsonl`, parses it with the real
`parseTranscript`, then runs `detectState` with the explicit `processAlive` /
`msSinceWrite` / `quietPeriodMs`. For triage cases it then runs `triageRules`.

## How to add a case

1. Append an object to `state.json` (and/or `triage.json`) following the format above.
2. **Label from the documented contract** in `src/core/stateDetector.ts` /
   `src/core/triage.ts` — not from whatever the code currently outputs. If you think a
   case proves a bug (code ≠ contract), open it as a bug; do not silently match the code.
3. `npm run eval` must stay green: **false-surface rate must be 0** (no WORKING/UNKNOWN
   case may be predicted WAITING_INPUT/DONE) and accuracy thresholds must hold.

## The one metric that matters

**False-surface rate** = of all cases whose true state is NOT ready (WORKING/UNKNOWN),
the fraction wrongly predicted ready (WAITING_INPUT/DONE). This is the project's one
safety promise — *never surface a session that isn't ready* — turned into a number.
It must be **0**; if it isn't, the eval exits non-zero and prints every offender.
