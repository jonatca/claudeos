# ClaudeOS Runbook — "it's down / I can't reach it"

**Point a Claude session at this file** (e.g. *"follow RUNBOOK.md, claudeos is down"*) and it will run these
steps in order and bring the cockpit back up. Each step is copy-pasteable on its own too.

The cockpit is **two servers on the server**: real on **:4317**, demo on **:4318**. "Down / can't reach it" almost
always means the server *process* died — not a code bug. The fix is usually one command: `npm run restart`.

---

## TL;DR — the one command

```bash
cd ~/code/claudeos && npm run restart
```

This builds, `pkill -9`s both old servers, starts fresh under `systemd --user`, and **verifies** both ports
answer `200` and the deployed build marker matches `HEAD`. If it prints `OK: deployed`, you're back —
hard-reload the browser (`Ctrl+Shift+R`). That's it 90% of the time. Steps below are for when it isn't.

---

## Full recovery (Claude: do these in order, stop when it's up)

### 1. Diagnose — is anything actually listening?

```bash
curl -s localhost:4317/ -o /dev/null -w "real(4317): %{http_code}\n" --max-time 5
curl -s localhost:4318/ -o /dev/null -w "demo(4318): %{http_code}\n" --max-time 5
ss -ltnp 2>/dev/null | grep -E "4317|4318" || echo "(nothing listening)"
ps aux | grep "dist/server/server.js" | grep -v grep || echo "(no server process)"
```

- `200` on both → it's actually **up**; the problem is the *browser/network*, not the server.
  Hard-reload (`Ctrl+Shift+R`); check the network if on your laptop. **Stop here.**
- `000` / "nothing listening" / "no server process" → the server is dead. Continue.

### 2. Make sure the build compiles (a half-finished edit can break it)

```bash
cd ~/code/claudeos && npm run build 2>&1 | tail -5; echo "BUILD_EXIT=${PIPESTATUS[0]}"
```

- `BUILD_EXIT=0` → good, go to step 3.
- **non-zero** → a TypeScript error is blocking it. Read the error, fix the named file, rebuild. Don't restart
  until the build is green (the server can't start from a broken `dist/`).

### 3. Restart (the real fix)

```bash
cd ~/code/claudeos && npm run restart
```

Wait for `==> OK: deployed — build marker matches HEAD`. If it instead says the marker **doesn't** match HEAD,
run `npm run restart` once more (a concurrent build clobbered `dist/` mid-deploy — see "Why it died" below).

### 4. Confirm it's stable

```bash
sleep 2
curl -s localhost:4317/ -o /dev/null -w "real(4317): %{http_code}\n" --max-time 5
curl -s localhost:4318/ -o /dev/null -w "demo(4318): %{http_code}\n" --max-time 5
```

Both `200` → **done.** Hard-reload the browser (`Ctrl+Shift+R`).

---

## Why it died (so it's less mysterious)

The usual cause is **many Claude sessions editing ClaudeOS at once**. The failure chain:

- One session runs `npm run test:ui` or `npm run restart` → that `pkill -9`s **both** node servers.
- Another session is mid-`npm run build`, overwriting `dist/` at the same moment.
- The restart's freshly-spawned server reads a half-written `dist/`, or the next session's build clobbers it →
  the spawn fails or serves broken code, and **nothing brings it back**. Result: ports dead, no process.

There is **no auto-restart guard** today — if it dies, it stays dead until someone runs the command above.
(If this keeps happening, the durable fix is adding `Restart=always` to the `systemd --user` unit so it
self-heals; ask Claude to do that as a separate change.)

## Gotchas (from CLAUDEOS.md)

- **Always deploy with `npm run restart`** — never a bare Ctrl-C/tmux restart. Only `restart` verifies the
  listening pid is the one it just spawned (kills the "stale orphan serving old code" gremlin).
- Renderer/UI changes need a **browser hard-reload** (`Ctrl+Shift+R`) — the server restart alone won't show them.
- If `npm run restart` itself errors, the most common root cause is the server's PATH missing `~/.local/bin`
  (where `claude` lives) — but `restart.sh` already sets that; a plain rerun usually clears transient failures.
