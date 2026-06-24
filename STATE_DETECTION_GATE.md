# The Ready-Gate — reliable "is it done / working / waiting?" detection (card 288)

**Goal:** a hard guarantee — *if a session is in Up Next, it is **definitely not** still outputting
tokens and **not** merely waiting on its own script.* A session surfaces only when it genuinely (a)
waits on the operator, or (b) is done. Anything still streaming, or blocked on its own background
work, stays hidden.

This document is the research report + design rationale for the gate that delivers that guarantee.

---

## TL;DR — what changed

The old detector (`stateDetector.ts`) was **pure heuristics** (transcript mtime, `stop_reason`,
marker/question regex). Heuristics are necessary but not sufficient: the `.jsonl` is written **per
completed message, not per token**, so a single tail-read can look finished mid-reply (the last
*completed* message reads like a question/done while more is still streaming), and a session that
merely *printed* a status line while still grinding on its own job can read as DONE.

The fix is a **3-layer ready-gate**, cheapest first, model last:

| Layer | What | Cost | Catches |
|---|---|---|---|
| **0 — heuristic** (`stateDetector.ts`, unchanged) | mtime/`stop_reason`/`tool_use`/markers | free | obvious WORKING (a tool is running, fresh write) → hidden instantly |
| **1 — double-sample** (`streamingSampler.ts`, NEW) | transcript signature **+ process-tree CPU** must be byte-stable/quiet across a config gap | free | **still streaming tokens** / still computing → hidden, with **no model call** |
| **2 — model classifier** (`workingVerifier.ts`, extended) | a model (`state_gate.model`, default **sonnet**) reads the tail → `WORKING / WAITING_ON_SELF / WAITING_ON_OPERATOR / DONE` | a few model calls (mtime-cached) | **WAITING_ON_SELF** (stopped, but blocked on its own script — incl. babysitters/heartbeat status reports) → hidden; only `WAITING_ON_OPERATOR`/`DONE` surface |

Layer 1 is the new core mechanism and it is **free**, so it gates the expensive Layer 2 — we never
pay a model to classify a session that is visibly still moving. Nothing enters Up Next without
clearing all three.

**2026-06-11 update (the "waiting-on-a-script still surfaces" fix):**
- **The recency window is GONE.** Previously only sessions that wrote within
  `surface_verify_window_ms` (120 s) were classified; anything quiet longer surfaced on the cheap
  text heuristics alone — exactly how "kicked off the script, will check back" sessions, quiet for
  10+ minutes, kept landing in the operator's queue as DONE/idle cards. Now **every alive candidate
  is verdict-gated before it may surface**, no matter how long it has been quiet. The verdict is
  mtime-cached, so an idle session costs ONE model call per transcript state, ever.
- **Model-down self-bound is now the fail-open counter** (`fail_open_attempts`, default 3): after
  that many consecutive failed/timed-out classifier checks on a stable session, the stable heuristic
  state surfaces anyway — a down model can never strand a ready session hidden (this replaces the
  old climb-past-the-window escape).
- **Self-wait TTL** (`self_wait_ttl_min`, default 60): a `WAITING_ON_SELF` verdict only hides while
  the session has been quiet less than this; past it the session surfaces as low-prio idle, so a job
  that finished without waking its session is never lost (the ETA probe can then re-hold it with a
  concrete "~Xm left"). `0` = hide until the transcript changes.
- **The gate model is `state_gate.model` (default sonnet, no longer `models.triage`)** and an
  `UNKNOWN` verdict can no longer overturn a heuristic-WORKING state ("can't tell" is no basis to
  surface something the cheap signals say is mid-flight).
- **Measured** on a 24-case goldset of real session tails (`npm run eval:verifier`,
  `src/eval/goldset/verifier.json`, review page `src/eval/results/verifier-review.html`):
  sonnet 72/72 exact over 3 repeats; haiku 0 false surfaces but wobbles DONE↔WAITING_ON_OPERATOR on
  borderline trailing-offer tails. Both models needed the iterated prompt — the original prompt let
  haiku misread a babysitter heartbeat ("all clean, next check in 30 min") as DONE.

The four classes reconcile to the existing `SessionState` like so (the two "not for you yet" classes
stay hidden):

```
WORKING             → SessionState WORKING        (HIDE)
WAITING_ON_SELF     → SessionState WORKING        (HIDE — blocked on its own job, nothing for you)
WAITING_ON_OPERATOR → SessionState WAITING_INPUT  (SURFACE)
DONE                → SessionState DONE            (SURFACE)
```

All cadence is config-driven (`config/weights.json → state_gate`): `classifier_enabled`, `model`,
`double_sample_gap_ms`, `settle_ms`, `min_verify_interval_ms`, `cpu_busy_frac`,
`fail_open_attempts`, `self_wait_ttl_min` (`surface_verify_window_ms` is legacy/ignored).

---

## Research — how others detect done vs working vs waiting

Claude's own "I'm done" signal is widely reported as unreliable; the field consensus is
**multi-signal triangulation**, never one signal. Findings, and how each is folded in here:

### 1. Transcript JSONL + `stop_reason`
Claude Code stores each session as append-only JSONL written at **logical event boundaries (per
completed message, not per token)** ([claude-dev.tools JSONL format](https://claude-dev.tools/docs/jsonl-format)).
`stop_reason` is the canonical "why it stopped": `end_turn` (natural), `tool_use` (wants a tool —
*not* done), `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`
([Anthropic — Handling stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)).
**Failure modes (documented):** Claude Code sometimes writes `stop_reason: null` when a `tool_use`
block is awaiting approval, so you must infer from **content blocks**, not the field alone
([claudectl](https://mercurialsolo.github.io/posts/claudectl-tui-dashboard/)); and `end_turn` can
appear on **empty 2–3-token replies** after tool results ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)).
→ *Used as Layer 0.* The detector already keys off `tool_use`/non-`end_turn`/markers; the gate no
longer trusts it alone.

### 2. Hooks — `Stop`, `SubagentStop`, `Notification`
Event-driven, so no polling. `Stop` fires "when Claude finishes responding" and carries
`last_assistant_message`; the **`Notification` hook is the cleanest *waiting* signal** — it matches
`permission_prompt`, `idle_prompt`, `elicitation_dialog`, i.e. fires exactly when Claude needs input
([Claude Code — Hooks reference](https://code.claude.com/docs/en/hooks)). **Failure mode:** an open
bug (#19220, Jan 2026) has the main-agent `Stop` hook reporting `hook_event_name: "SubagentStop"`,
making main-vs-subagent indistinguishable at the hook level
([GitHub #19220](https://github.com/anthropics/claude-code/issues/19220)). → *Noted as the highest-
leverage future upgrade* (see below). ClaudeOS's server reads the server's filesystem every tick rather
than installing per-session hooks, so the gate stays transcript-based for now.

### 3. tmux pane idle-detection / output-diffing
Orchestrators that can't read the process scrape the terminal: the PrimeLine tmux orchestrator
reads `capture-pane`, **strips ANSI first**, then checks the last ~12 lines for spinner words
(`Running`, `thinking`, `Writing`) before a prompt glyph, with **adaptive polling (30s stuck / 120s
normal / 300s idle)** ([primeline-ai/claude-tmux-orchestration](https://github.com/primeline-ai/claude-tmux-orchestration),
[blog](https://primeline.cc/blog/tmux-orchestration)); claude-squad and claude-tmux do similar
([claude-squad](https://github.com/smtg-ai/claude-squad), [claude-tmux](https://github.com/nielsgroen/claude-tmux)).
**Why it works:** double-sampling the output (capture twice, compare) directly answers "is it still
changing?" — the literal definition of streaming. **Failure mode:** spinner glyphs/prompt chars
drift across versions; a blinking cursor can look like change. → *Adopted as Layer 1, but we sample
the **transcript** (already ANSI-free, structured) instead of scraping the pane — more robust than
`capture-pane`.*

### 4. Process CPU (the strongest cheap signal)
claudectl's key finding: **CPU is the single strongest signal** — ">5% CPU, the process is working,
period," overriding the lagging JSONL; and because **permission prompts leave no transcript trace**,
it infers "waiting" from low CPU + a stale `tool_use`
([claudectl](https://mercurialsolo.github.io/posts/claudectl-tui-dashboard/)). → *Folded directly
into Layer 1:* the double-sample treats a session as still-active if **either** the transcript moved
**or** the process tree burned > `cpu_busy_frac` CPU since the last sample. This catches the case the
transcript signal misses — mid-*compute* between completed messages, or a non-writing tool.

### 5. General LLM-agent patterns
Sentinel/terminal markers, structured output, idle-timeout, double-sampling for stability, and a
**cheap secondary LLM-as-judge** are standard ([MindStudio](https://www.mindstudio.ai/blog/llm-as-judge-agent-safety-pattern)).
Important caveat: judges are **stochastic even at temperature 0** — identical inputs can yield
different verdicts ([SentinelAgent, arXiv 2505.24201](https://arxiv.org/html/2505.24201v1)). →
*Layer 2 is used conservatively:* it runs only **after** the free, deterministic Layers 0–1, it only
ever moves a session **toward more hidden** or confirms an already-stable candidate, and any model
failure returns `null` → keep the (hidden) heuristic verdict. The model is a backstop, never the
sole authority.

### Sources
- Anthropic — Handling stop reasons — https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
- Claude Code — Hooks reference (Stop / SubagentStop / Notification) — https://code.claude.com/docs/en/hooks
- GitHub anthropics/claude-code #19220 — Stop hook receives "SubagentStop" — https://github.com/anthropics/claude-code/issues/19220
- claudectl — multi-signal session state (CPU, `stop_reason: null`, permission inference) — https://mercurialsolo.github.io/posts/claudectl-tui-dashboard/
- claude-dev.tools — JSONL transcript format — https://claude-dev.tools/docs/jsonl-format
- primeline-ai/claude-tmux-orchestration — https://github.com/primeline-ai/claude-tmux-orchestration · blog: https://primeline.cc/blog/tmux-orchestration
- smtg-ai/claude-squad — https://github.com/smtg-ai/claude-squad
- nielsgroen/claude-tmux — https://github.com/nielsgroen/claude-tmux
- MindStudio — LLM-as-Judge agent safety pattern — https://www.mindstudio.ai/blog/llm-as-judge-agent-safety-pattern
- SentinelAgent (judge stability) — arXiv 2505.24201 — https://arxiv.org/html/2505.24201v1

---

## How Layer 1 works (the double-sample), precisely

`StreamingSampler.consider(id, sample, gapMs, cpuBusyFrac)` keeps the **last** sample per session.
A sample is `{ sig, cpuJiffies, at }` where:
- `sig = transcriptSig(tail, mtimeMs)` = `mtime : byteLength : sha1(tail)` — **free**, computed from
  the 128 KB tail the tick already read. Any newly-written token changes it.
- `cpuJiffies = processTreeJiffies(pid)` = utime+stime of the session's process **tree** (pane shell
  + the real `claude` child), from `/proc`. `null` (no `/proc`, unknown pid) → CPU signal skipped,
  transcript signal alone still applies.

A session is **stable** (eligible to surface) only when it has been **continuously quiet** —
transcript unchanged **and** CPU < `cpu_busy_frac` — for at least `gapMs`. Any change resets the
quiet timer. It rides the existing ~5 s tick (consecutive ticks are the two samples; no new timers).

Because the dangerous case (looks-ready-but-still-streaming) is exactly when the next completed
message lands within the gap, the gap must exceed the longest plausible inter-message write gap
during one stream (default 5 s; `surface_verify_window_ms` = 120 s bounds the whole guard so a
finished session is never stranded).

## Liveness — who the gate even applies to (the pid=null fix)

Every layer above is conditioned on *"the session is alive"*. **Discovered external sessions — the
operator's real tmux panes — carry `pid=null`** (discovery maps them by transcript, not by launch)
and their tmux session isn't `cockpit-<slug>`, so `processAlive()` alone is **false** for all of
them. That silently disabled the entire gate for exactly the sessions that matter: a session still
outputting tokens surfaced into Up Next as a question/done/idle card, and a mid-`tool_use` live pane
read as "stalled" (dead-process rule) and surfaced as idle.

The fix (mirrors what `handleEta` reachability already did): the engine treats
`processAlive(s) || s.is_live_pane === 1` as alive. `is_live_pane=1` is proof of life — discovery
maps a pane only by walking a **live** claude process (agent pid / open transcript fd) up to its
tmux pane, and `clearLivePanes` resets it the moment that process is gone.

## The babysit/waiting pane flag (👶/🕐)

The operator's sessions declare "alive but only watching my own long job" via the pane-scoped tmux
option `@claude_status` (`~/.claude/babysit.sh on` / `waiting.sh on`). The engine reads ALL panes'
flags in one cached `tmux list-panes -a` call (`SessionManager.paneBabysit`) and:

- an **idle (UNKNOWN)** flagged session is **held out** of Up Next (`flagHold`, same shape as the
  ETA hold), and an already-surfaced idle card is pulled (`state='UNKNOWN'`-scoped supersede) when
  the flag goes up — including for LOCKED cards;
- a flagged session is run through the double-sample + Haiku gate **regardless of how long it has
  been quiet** (long poll gaps are its normal shape — the 120 s window alone would let a
  10-min-quiet babysitter surface on the heuristic), so only genuinely-DONE / needs-operator
  verdicts surface;
- a **question always wins**: WAITING_INPUT surfaces despite the flag, and a pane whose volatile
  `@claude_pane_status` is `input` (❓) is never reported as babysitting.

Self-healing: the flag clears via `babysit.sh off` or pane death (`is_live_pane` reset), and a real
completion surfaces as a Haiku-confirmed DONE.

## Layer 2 prompt (the 4-way classifier)

`workingVerifier.ts → classifierPrompt()` asks the model to judge **only the end of the transcript**
and pick one of `WORKING | WAITING_ON_SELF | WAITING_ON_OPERATOR | DONE | UNKNOWN`, with decisive
rules: a tool call last ⇒ WORKING; "running X / waiting for X / will check back" with no question ⇒
**WAITING_ON_SELF** (not done); a question/approval ⇒ WAITING_ON_OPERATOR; a completion report ⇒
DONE. The parse/map (`parseVerdict`, `mapActivity`) is pure and unit-tested.

---

## Tests

- **Unit (`harness.ts` → `stateGateTests`)**: the transcript signature; the double-sample never calls
  a streaming session stable (sig changes every sample → never stable, even with a huge gap); a
  stopped session becomes stable only after the gap; the CPU signal (static transcript + >5% CPU →
  not stable; ~idle → stable); `processTreeJiffies(null/absurd) → null`; the 4-way parse/map incl.
  **WAITING_ON_SELF stays hidden**; config defaults. Plus src-wiring guards on the engine gate.
- **Integration**: the full offline pipeline still hides every actively-WORKING session and surfaces
  WAITING_INPUT/DONE/idle (existing assertions, kept green).
- **Live (`live_test.ts`, `COCKPIT_LIVE=1`)**: a real launched session reads WORKING+hidden while it
  counts; transitions to WAITING_INPUT+surfaced when it asks; **Part C** — a session blocked on its
  own `sleep &` job stays hidden (WAITING_ON_SELF).
- **Live reliability probe (`state_gate_live.ts`, `COCKPIT_LIVE=1`)**: runs the full gate over the
  operator's **real sessions on this box** (on a copy of the live DB; transcripts read-only) and
  reports OLD-vs-NEW surface counts.

### Measured reliability

Run over **30 real sessions** on the server: the gate surfaced exactly the safe set and **never
surfaced more than the legacy heuristic** (the invariant the guarantee rests on — the gate only ever
*hides* more, never *shows* more). Dead-process sessions (a dead process cannot stream) correctly
surface on the heuristic; the double-sample + Haiku engage only for **alive + recently-active**
candidates, which is exactly the window where a reply can still be streaming. The dramatic
false-surface case is transient by nature (the seconds a reply streams); it is pinned deterministically
by the harness (`a STREAMING session is NEVER stable`) and by `live_test.js` Part B1/C.

---

## Future upgrade (highest leverage)

Install a Claude Code **`Notification` hook** (`permission_prompt`/`idle_prompt`) and a `Stop` hook
as an **authoritative edge-trigger** for "waiting on the human" / "finished", backed by this gate for
liveness. That is the one signal that is in-process truth rather than inferred — carry the #19220
main-vs-subagent workaround. It would make WAITING_ON_OPERATOR detection near-instant and free.
