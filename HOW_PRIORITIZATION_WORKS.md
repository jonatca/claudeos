# How ClaudeOS Prioritization Works

How the app decides which session is "the one to look at next" — how it gets a
priority, how the queue is ordered, and what triggers it all. Grounded in the
current code on `feat/local-terminal-alt`.

---

## TL;DR

1. **Every 5 seconds** the engine wakes up (`tick`) and looks at all your Claude
   sessions.
2. **First it filters by STATE.** Only sessions that are *ready for you* —
   `WAITING_INPUT` or `DONE` — can ever surface. A session that's actively
   `WORKING` is **never** shown. That "never surface working work" promise is
   the project's hard safety rule (measured as **false-surface rate = 0**).
3. **Then it scores each ready session** with a transparent formula:
   `score = Σ(weight × signal) + learned nudges + your overrides`.
4. **The queue is just those scores sorted high→low.** `queue[0]` is the
   recommendation shown in the main pane.
5. **Nothing is a black box** — each item carries a `breakdown` showing exactly
   which signals contributed how many points.

The big mental shift: **priority is not assigned, it's *computed*** from live
signals. There's no "mark as priority" button that sets a flag — instead you
nudge the *inputs* (focus, importance, snooze, h/l) and the score recalculates.

But there's one **firm exception that overrides everything below** — read it first:

---

## Stage 0 — THE UP-NEXT LOCK (this runs *before* anything else)

**Once a session is in Up Next, the engine leaves it completely alone.**

The operator's hard rule: *"I will never be automatically moved off the task I'm
looking at."* So the very first thing each tick does is collect every session
that **already has a pending item** (i.e. is already in Up Next) and **skip them
entirely** — no state detection, no re-ranking, no superseding, no re-surfacing.
A locked task stays *exactly* as you last saw it:

- It **never flickers out** of Up Next when its worker starts writing again
  (you sent it a message, it's now `WORKING`). Previously a "stale prune"
  dropped it the instant it went `WORKING`, the view auto-flipped to the next
  task, and it reappeared a minute later — that whole class of bug is gone.
- Its **priority is frozen**. The automatic tick (and the nightly dream) will
  never renumber a task that's already in Up Next.

A locked task only leaves Up Next when **you** act on it — answer, ack, dismiss,
or complete (→ its item is no longer `pending`) — or the session is deleted
(orphan prune). The moment it leaves, it's unlocked and the engine may evaluate
it again on the next tick.

So **all the scoring/ranking machinery below only ever applies to sessions that
are NOT yet in Up Next.** The engine looks only at not-in-Up-Next sessions,
decides whether each is ready, and if so *adds* it to Up Next at a computed
priority — and then freezes it. (`src/core/engine.ts` `_tick`: `lockedSessionIds`.)

**Operator overrides still work** because they don't go through the automatic
tick — pin / snooze / importance / h-l all flow through `rerank()` (the cheap
quick-action path), which *you* triggered, so re-scoring the item you just acted
on is exactly what you asked for. The lock only stops the engine from doing it
*on its own*.

---

## The pipeline (one tick) — `engine.tick()`

`CLAUDEOS.md` and `src/core/engine.ts` lay it out as 5 stages:

```
        every 5s (tick_interval_ms)
              │
     ┌────────▼─────────┐
     │ 1. DISCOVER       │  scan ~/.claude/projects/ for recent sessions
     ├──────────────────┤
     │ 2. DETECT STATE   │  tail each transcript → WORKING / WAITING_INPUT / DONE / UNKNOWN
     ├──────────────────┤
     │ 3. TRIAGE         │  classify the READY ones: SIMPLE_Q / REVIEW_DIFF / COMPLEX_DECISION / FYI_DONE
     ├──────────────────┤
     │ 4. RANK           │  score every ready item → sort high→low   ◀── "prioritization"
     ├──────────────────┤
     │ 5. ENRICH         │  background claude -p for one-liner summaries + suggested answers
     └────────┬─────────┘
              ▼
        broadcast CockpitState  →  UI renders next + queue
```

Triggered by:
- **The 5s tick loop** (`server.ts:71-102`, `tick_interval_ms: 5000`).
- **Manual actions** → a `quickRerank()` (re-score from DB, no re-discover) for
  instant feedback on snooze / nudge / answer; heavier actions (ack, complete,
  takeover) run a full `tick`.
- **The nightly "dream"** (~03:00) which *learns* and adjusts the weights.

---

## Stage 2 — STATE is the gate (this comes *before* priority)

`src/core/db.ts:18`:
```typescript
export type SessionState = "WORKING" | "WAITING_INPUT" | "DONE" | "UNKNOWN";
```

The rule (`engine.ts:6-8`): **only `WAITING_INPUT` and `DONE` ever become an
item.** `WORKING` / `UNKNOWN` update their state column but never surface as
actionable. (Per `engine.ts:160`, the current policy surfaces *everything that
isn't actively WORKING*, so UNKNOWN/idle shows up but ranks low via `idle_base`.)

How state is detected (`src/core/stateDetector.ts`), by tail-reading the
transcript:

| Signal | → State |
|---|---|
| process alive **and** wrote within 4s (`quiet_period_ms`) | **WORKING** (streaming) |
| last assistant turn `stop_reason='tool_use'` or ends on a `tool_result` | **WORKING** (mid-task) |
| clean `end_turn` **and** text asks a question (`?`, "would you like", "confirm", "ready for review") | **WAITING_INPUT** |
| transcript has a `needs input:` marker (background sessions emit this) | **WAITING_INPUT** |
| `result:`/`failed:` marker, or text says done/finished/merged/deployed | **DONE** |
| clean end, not a question, not a done-marker | **UNKNOWN** (idle/parked) |

"Process alive" includes a **discovered live pane** (`is_live_pane=1`) — the operator's real tmux
sessions carry no pid, and without this the streaming/mid-task rules (and the whole ready-gate)
never applied to them. Additionally, a pane flagged **👶 babysit / 🕐 waiting** (`babysit.sh` /
`waiting.sh`) is never surfaced while idle: it's declared as watching its own job (`flagHold` in
`engine.ts`; a question still beats the flag). And since 2026-06-11, **every alive session — flagged
or not, however long quiet — must clear the model ready-gate before it may surface**: a verdict of
`WAITING_ON_SELF` ("kicked off the script, will check back", a babysitter heartbeat) keeps it hidden
(up to `state_gate.self_wait_ttl_min` of silence), so waiting-on-its-own-job sessions no longer leak
into the queue via the text heuristics. See `STATE_DETECTION_GATE.md`.

### Why this matters: the "false-surface rate"

`src/eval/run.ts:1-8` states the promise:
> "never surface a session that isn't ready for the operator… A FALSE SURFACE
> (a truly-working / ambiguous session predicted as ready) is the worst failure
> mode, so we measure it directly… and gate on it being exactly 0."

A false surface = the app interrupting you about a session that's actually still
working. The goldset eval **fails the build** if even one occurs (`run.ts:201`).
So state-gating is deliberately conservative: when in doubt, stay hidden.

---

## Stage 4 — RANK: the transparent score

`src/core/priority.ts:scoreItem()`. The formula:

```
score = Σ (weight_i × signal_i)        ← base signals (weights.json)
      + Σ learned_adjustments          ← nightly "dream" per-category nudges (±40)
      + operator overrides             ← manual importance / h-l delta / snooze
      + pin/active boosts              ← forced positioning
```

### The signals and their weights (`config/weights.json`)

| Signal | Weight | What it measures |
|---|---:|---|
| `llm_importance` | **60** | a cheap LLM rates the session 0–100 vs. your focus (dominant signal) |
| `blocks_other_work` | 30 | flagged as blocking other work |
| `deadline` | 26 | urgency of an ISO deadline |
| `focus_match` | 22 | keyword overlap with your declared focus |
| `needs_input_bonus` | 20 | state is `WAITING_INPUT` (actionable beats FYI) |
| `effort_small` | 18 | smaller diffs clear faster (0 lines→1.0, ≥400→0.0) |
| `staleness` | 14 | age in hours (24h ≈ +1×weight) |
| `done_bonus` | 6 | state is `DONE` (informational FYI) |
| `idle_base` | **−8** | state is `UNKNOWN`/idle (sinks low, never hidden) |

Every signal call appends a term to a `breakdown` array with its contribution
and a human reason — so the UI can show *"ranked here because: llm_importance
+48, focus_match +15, staleness +6…"*. **Fully inspectable.**

### Operator overrides (how *you* set priority)

You don't set a flag — you push the inputs:

- **Manual importance** (0–100): replaces the LLM's judgment for that item.
- **h / l nudge**: a per-item "rank higher / lower" delta that persists.
- **Snooze**: adds `snooze_penalty: -40` (stacks, capped 3×) → sinks it to the
  bottom **but keeps it visible**. Cleared when the task is completed.
- **Pin**: `PIN_BASE = 100000` → forced to the very top.
- **Active task**: when you open a session's terminal, `setActiveSession()`
  floats it to *just above* the rest (`maxOrganic + ACTIVE_OVER`, a readable
  +5 — so it reads like 63 next to 58, not a flat 100k).

### Learned adjustments (the nightly "dream")

The feedback loop *never edits `weights.json`*. Instead, around 03:00 it reads
how you actually triaged (`decision_log`) and writes per-category nudges into an
`adjustments.json` / `signal_adjustments` table (clamped ±40), and evolves the
human-readable `config/RANKING.md`. Teaching strength is graded
(`weights.json`):

- **Silently picking a non-top task / snoozing** → 0.1× learning rate (almost
  nothing — it's an ambiguous signal).
- **A bare h/l nudge** → 5× (a clear direction).
- **h/l *with a typed reason*** ("I don't want this because X") → 15× — the
  dominant teacher (≈150× a silent pick).

`config/RANKING.md` (the learned rules, in plain English):
> - Prod-reliability / inference-blocking issues outrank everything else.
> - A focus-matched task usually beats a higher raw-importance off-focus task.
> - Operator overrides take precedence over auto-ranking.
> - Long code reviews are lower-priority than quick blocking decisions.
> - Cleanup/refactor defers while anything waits on a real decision.
> - A consequential architectural/data-correctness decision ranks high even if slow.
> - Trivial yes/no confirmations are low unless they block other work.

---

## Stage 3 — TRIAGE (what *kind* of attention it needs)

Triage doesn't set priority — it labels the *type* of interaction so the UI can
render the right pane. `src/core/triage.ts`:

```typescript
type TriageCategory = "SIMPLE_QUESTION" | "REVIEW_DIFF" | "COMPLEX_DECISION" | "FYI_DONE";
```

Cheap rules run first (`weights.json → triage`):
- `DONE` → **FYI_DONE**
- asks for review **and** ≥12 changed lines → **REVIEW_DIFF**
- presents ≥2 options (or long + has options) → **COMPLEX_DECISION**
- ≤240 chars, no options → **SIMPLE_QUESTION**
- uncertain → fall through to a haiku LLM call (45s timeout)

Each result carries `source: 'rules' | 'claude'` and a ≤12-word `reason`.

---

## How the UI orders the list — `engine.queue()`

`src/core/engine.ts:634`:
```sql
SELECT * FROM items
WHERE status='pending'
  AND (snooze_until IS NULL OR snooze_until < datetime('now'))
  AND session_id NOT IN (SELECT id FROM sessions WHERE completed_at IS NOT NULL)
ORDER BY priority DESC, updated_at DESC
```

1. **priority DESC** (highest score first)
2. **tiebreak: `updated_at DESC`** (most recently changed wins)
3. then the **active task floats to #1** if you've opened it.

`server.ts:state()` packages it as `{ next: queue[0], queue, ... }`. The
renderer shows `next` in the focused pane and the rest as the (toggleable)
queue list.

---

## The whole thing in one picture

```
            ┌──────────── every 5s tick ─────────────┐
            ▼                                         │
  ~/.claude/projects/  ──DISCOVER──▶  sessions        │
                                        │             │
                                  DETECT STATE        │
                                        │             │
                  ┌─────────────────────┼──────────────────────┐
                  ▼                     ▼                       ▼
              WORKING              WAITING_INPUT / DONE       UNKNOWN
              (hidden,          (READY → become items)     (low, idle_base −8)
           never surfaced)             │
                                       ▼
                                    TRIAGE  ──▶ SIMPLE_Q / REVIEW_DIFF / COMPLEX / FYI
                                       │
                                       ▼
                          RANK: score = Σ(weight×signal)
                                       + learned nudges (nightly dream)
                                       + your overrides (importance / h-l / snooze / pin)
                                       + active-task float
                                       │
                                       ▼
                          ORDER BY priority DESC, updated_at DESC
                                       │
                                       ▼
                          next = queue[0]  ─────▶  UI: focused pane + queue list
```

---

## Mental model / analogy

It's an **assistant triaging your inbox every 5 seconds**, with two firm rules:

1. **"Don't bug me about something still in progress."** A session that's
   actively typing/tool-calling is invisible — full stop. (false-surface = 0)
2. **"Of the things that genuinely need me, sort by how much they need me."**
   That sort is a transparent points total — importance, does-it-block,
   deadline, on-my-focus, how-quick-to-clear, how-stale — plus what it's
   *learned* from your past choices, plus any manual overrides you've made.

You don't "set" priority; you adjust the ingredients (set your focus, bump
importance, snooze, type a reason for h/l) and the score re-cooks itself.

---

## Key files

| File | Role |
|---|---|
| `src/core/engine.ts` | The tick pipeline + `queue()` ordering (line 634) + state gate (160) |
| `src/core/stateDetector.ts` | WORKING / WAITING_INPUT / DONE / UNKNOWN detection |
| `src/core/triage.ts` | Categorize ready sessions (rules + haiku fallback) |
| `src/core/priority.ts` | **The transparent score formula** (`scoreItem`) |
| `config/weights.json` | Signal weights, triage thresholds, learning rates, cadence |
| `config/RANKING.md` | Human-readable learned ranking rules (evolved nightly) |
| `src/eval/run.ts` | The false-surface-rate gate (must be 0) |
| `src/server/server.ts` | 5s tick loop, action endpoints, `state()` broadcast |
| `CLAUDEOS.md` | Architecture overview of the 5-stage pipeline |
