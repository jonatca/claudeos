# ClaudeOS — Setup

How to get ClaudeOS running on your own machine from a fresh checkout. For *what it is*
and the module map, see [`README.md`](README.md); for day-to-day ops, see
[`CLAUDEOS.md`](CLAUDEOS.md) and [`RUNBOOK.md`](RUNBOOK.md).

> Naming note: internals (dirs, the SQLite file `cockpit.db`, tmux sockets, `COCKPIT_*`
> env vars, npm scripts) keep the legacy name **cockpit**. Only the branding is ClaudeOS.

---

## 1. Prerequisites

- **Node ≥ 22.5** — ClaudeOS uses the built-in `node:sqlite`, so there is **no native DB
  build step and no API key**. Check: `node -v`.
- **Claude Code CLI**, logged in. ClaudeOS shells out to `claude -p` for triage/summaries
  and uses **your Claude Code subscription** — no Anthropic API key anywhere. Verify
  `claude -p "say hi"` works before starting.
- **git** and **tmux** — sessions run in isolated git worktrees inside tmux panes.
- **Desktop app only** (optional): a display, plus the platform build deps for `node-pty`
  (see [`desktop/README.md`](desktop/README.md)). The headless web-server mode needs none
  of this.

---

## 2. Install & build

```bash
git clone <your-clone-url> claudeos && cd claudeos
npm install        # postinstall wires up the git hooks (build gate)
npm run build
```

`npm install` sets `core.hooksPath` to `scripts/git-hooks` (pre-commit build + pre-push
test gate). To enable by hand later: `npm run hooks:install`.

---

## 3. Configure for YOUR machine

All config is in [`config/weights.json`](config/weights.json) (priority weights, triage
thresholds, models, automation) and [`config/keymap.json`](config/keymap.json) (keys).
**Nothing here is secret**, and the shipped defaults are deliberately generic (mostly empty) —
point these at your own setup before wiring in real work:

| Field | What it is | Change to |
|---|---|---|
| `kanban_repo` | repo whose tasks/worktrees ClaudeOS manages | your repo path |
| `sessions_repos` | repos offered in the new-session launcher | your repo path(s) |
| `kanban_path` | folder of kanban `.md` cards (optional feature) | your kanban dir, or ignore |
| `pr_repos` | GitHub `owner/repo`s scanned for open PRs (via `gh`) | your repos, or `[]` |
| `default_base_branch` | branch the Diff view compares against | your trunk (e.g. `main`) |
| `models.triage` / `models.summary` | which `claude -p` models to use | keep, or your preference |

The feedback loop writes learned nudges to `data/` (`adjustments.json` + `cockpit.db`),
**never** back into `weights.json`, so your edits stick.

---

## 4. Run it

**Local (the default — engine + terminals all on one machine):**
```bash
npm run serve          # -> http://localhost:4317   (open it in your browser, same machine)
```
By default the server binds all interfaces (`0.0.0.0`) so the optional remote-browser mode below
also works. To keep it **strictly local-only**, set `COCKPIT_HOST=127.0.0.1`.

**Desktop app (native window, also fully local):**
```bash
npm start              # normal desktop
npm run start:xvfb     # headless box via xvfb
```

**Optional — engine on a separate / headless machine, browser on your laptop:**
```bash
npm run serve                          # on the server (where sessions run): -> http://0.0.0.0:4317
ssh -L 4317:localhost:4317 <host>      # on your laptop, then open http://localhost:4317
```
Set `COCKPIT_SSH_HOST=<host>` so the in-app attach commands point at the right box. This multi-machine
mode is opt-in — the two modes above run entirely on one computer.

**Demo / offline (no real sessions, no Claude calls — good for a first look):**
```bash
npm run demo           # seed mixed-state demo sessions
COCKPIT_NO_ENRICH=1 npm start
```

**Redeploy after changes** — always use `restart` (it pkills the old process, rebuilds, and
verifies the served build hash == HEAD, so you never run stale code):
```bash
npm run restart
```

**Wire in a real session:**
```bash
node dist/cli.js launch /path/to/repo "short title" "full task prompt"   # new isolated worktree+branch
node dist/cli.js register /path/to/repo "title" /path/to/worktree branch # watch an existing one
node dist/cli.js list
```

---

## 5. Tests & evals

```bash
npm test               # build + all 4 tiers (~55s): core · answer-feedback · server E2E · UI click-through
npm run eval           # score the safety goldset (state + triage); gates on false-surface == 0
npm run eval:verifier  # Layer-2 classifier vs the live model (spends a few claude -p calls)
```

The push gate (pre-push hook) runs build + core + server E2E on pushes to `master`;
`FULL=1 git push` also runs the browser UI tier. Keep `master` green.

---

## 6. ClaudeOS-specific gotchas

- **Ports 4317 (real) / 4318 (demo)** are the convention for your main instance; a fresh clone
  starts there fine. Run a *second* dev/eval instance with `COCKPIT_PORT >= 5000` (it gets its own
  isolated `data/cockpit.db`). To hard-guard 4317/4318 against a stray second server stealing your
  task queue, set `COCKPIT_CANONICAL_ROOT` to your main checkout's path (off by default).
- **All data is local & yours:** `data/cockpit.db` (SQLite) + `data/*.json`. `data/`,
  `*.db`, `node_modules/`, `dist/`, and `.claude/worktrees/` are gitignored.
- **The nightly "dream" (~03:00)** re-tunes ranking from your decisions, evolves
  `config/RANKING.md`, and **auto-commits + pushes** that file. If you don't want ClaudeOS
  pushing, point the repo at a remote you control (or it just logs a push failure and
  retries next night — harmless).
- **No secrets needed or wanted.** ClaudeOS authenticates only through your local Claude
  Code session; there are no API keys or credentials in this repo. Don't add any.
- **Eval data is local-only by design.** `src/eval/goldset/verifier.json` and
  `pending-review.json` contain real session transcripts and are gitignored; the tracked
  `verifier.sample.json` (synthetic) lets `eval:verifier` run on a fresh clone. See
  [`src/eval/goldset/README.md`](src/eval/goldset/README.md). Generate your own real cases
  with `npm run eval:sample` (reads your `~/.claude` transcripts).
- **First launch auto-accepts** the per-worktree "trust this folder" dialog by writing
  `hasTrustDialogAccepted` into `~/.claude.json` (same as clicking *Yes, I trust*), so
  sessions don't stall on first run.
