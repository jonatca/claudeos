# ClaudeOS — Claude Code Instructions

Architecture, the terminal model, and the hard-won gotchas live in **[CLAUDEOS.md](./CLAUDEOS.md)** —
read it first. This file just exists so Claude Code auto-loads them (it loads `CLAUDE.md`, not
`CLAUDEOS.md`).

@CLAUDEOS.md

## Workflow

- Prefer **branch → PR → merge into `master`** (squash). Small docs/typos may go directly to `master`.
- **Keep `master` green — a git hook enforces it.** Hooks live in `scripts/git-hooks/` and activate
  via `npm install` (postinstall sets `core.hooksPath`); enable by hand with `npm run hooks:install`.
  - **pre-commit** → `npm run build` (a commit that doesn't compile is blocked).
  - **pre-push to `master`/`main`** → build + core harness + server E2E (~40s); the push lands only
    if green. Pushing a *branch* skips the gate (iterate fast — gate when you merge to master).
    `FULL=1 git push` also runs the browser UI tier.
- **`--no-verify` only** for small, non-behavioral commits (docs, comments, a `.md`). Anything that
  changes behavior (core/engine/server/renderer, `db.ts`/migrations, terminal/merge/undo/ranking)
  **must** let the tests run.
- **Every new feature/behavior ships with a test** — `src/test/harness.ts` for core logic,
  `e2e_server.ts` for an endpoint/WS change, `e2e_ui.ts` for a button/keybinding. A feature without a
  test is not finished; the pre-push gate is what keeps it from regressing.

## Running a dev/eval server — don't clobber a real instance

Ports **4317 (real) / 4318 (demo)** are the convention for a canonical instance. Run any dev/eval/test
server with **`COCKPIT_PORT=5000+`** — it gets its own isolated `data/cockpit.db` automatically, so it
can't replace a running instance's task queue.

If you run a persistent instance (e.g. a systemd `--user` unit) and want a hard guard against a second
server stealing 4317/4318, set `COCKPIT_CANONICAL_ROOT` to that checkout's path — `server.ts` then
refuses to start on those ports from any other checkout. By default the guard is a no-op, so a fresh
clone always starts on 4317/4318.

## Deploy / redeploy

Always redeploy with **`npm run restart`** — it rebuilds, kills the old process, and verifies the
served build hash matches `HEAD`, so you never serve stale code. After a discovery/schema change, run
`npm run reset-real`. See [`SETUP.md`](SETUP.md) for the full run/build/test reference.
