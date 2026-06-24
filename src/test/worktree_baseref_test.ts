/**
 * Worktree base-ref test. Locks in createWorktree's base resolution: a repo with
 * `git config cockpit.baseref <branch>` cuts new session worktrees from origin/<branch>
 * (your-repo: integration) instead of origin/HEAD (stale master → sessions missing
 * .claude/commands). Also: explicit baseRef still wins, no-config repos keep the old
 * behavior, and the new cockpit branch must NOT track the base (a bare `git push` in a
 * session must never target the protected base branch).
 *
 * Standalone ring, real git in a throwaway dir. Run: node dist/test/worktree_baseref_test.js
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { check, summary } from "./helpers";
import { createWorktree } from "../core/worktree";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-wt-baseref-"));
const sh = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

let repoN = 0;
function makeRepo(): { repo: string; origin: string } {
  // Bare "origin" with master (HEAD) + a dev branch that has an extra command file,
  // mirroring your-repo's master-lags-integration shape.
  const n = ++repoN;
  const origin = path.join(ROOT, `origin-${n}.git`);
  const seed = path.join(ROOT, `seed-${n}`);
  fs.mkdirSync(seed);
  sh(seed, ["init", "-q", "-b", "master"]);
  sh(seed, ["config", "user.email", "t@t"]);
  sh(seed, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(seed, "base.txt"), "base\n");
  sh(seed, ["add", "."]);
  sh(seed, ["commit", "-q", "-m", "base"]);
  sh(seed, ["checkout", "-q", "-b", "dev"]);
  fs.mkdirSync(path.join(seed, ".claude/commands"), { recursive: true });
  fs.writeFileSync(path.join(seed, ".claude/commands/goodnight.md"), "only on dev\n");
  sh(seed, ["add", "."]);
  sh(seed, ["commit", "-q", "-m", "dev-only command"]);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { stdio: "ignore" });
  sh(origin, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  const repo = path.join(ROOT, `checkout-${n}`);
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  sh(repo, ["config", "user.email", "t@t"]);
  sh(repo, ["config", "user.name", "t"]);
  return { repo, origin };
}

function main(): number {
  // 1. No config → old behavior: base = local default branch, dev-only file absent, and
  //    LOCAL-ONLY commits (ahead of origin) are still included — no network, no origin pref.
  const { repo: plain } = makeRepo();
  const wt1 = createWorktree(plain, "sess-1");
  check("no cockpit.baseref → worktree cut from default branch (master)",
    !fs.existsSync(path.join(wt1.path, ".claude/commands/goodnight.md")) &&
    fs.existsSync(path.join(wt1.path, "base.txt")));
  fs.writeFileSync(path.join(plain, "local-only.txt"), "not pushed\n");
  sh(plain, ["add", "."]);
  sh(plain, ["commit", "-q", "-m", "local-only commit"]);
  const wt1b = createWorktree(plain, "sess-1b");
  check("no cockpit.baseref → local commits ahead of origin still included",
    fs.existsSync(path.join(wt1b.path, "local-only.txt")));

  // 2. cockpit.baseref=dev → worktree sees the dev-only command file.
  const { repo: cfged, origin: cfgedOrigin } = makeRepo();
  sh(cfged, ["config", "cockpit.baseref", "dev"]);
  const wt2 = createWorktree(cfged, "sess-2");
  check("cockpit.baseref=dev → worktree contains the dev-only .claude command",
    fs.existsSync(path.join(wt2.path, ".claude/commands/goodnight.md")));
  check("cockpit branch name unchanged (cockpit/<slug>)", wt2.branch === "cockpit/sess-2");
  let upstream = "";
  try { upstream = sh(wt2.path, ["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(); } catch {}
  check("cockpit branch does NOT track the base (bare `git push` can't hit dev)", upstream === "");

  // 3. Freshness: a commit pushed to origin/dev AFTER the clone still lands in a new
  //    worktree (resolveBase fetches + prefers origin/<name> over the stale local ref).
  const writer = path.join(ROOT, "writer");
  execFileSync("git", ["clone", "-q", cfgedOrigin, writer], { stdio: "ignore" });
  sh(writer, ["config", "user.email", "t@t"]);
  sh(writer, ["config", "user.name", "t"]);
  sh(writer, ["checkout", "-q", "dev"]);
  fs.writeFileSync(path.join(writer, ".claude/commands/fresh.md"), "pushed after clone\n");
  sh(writer, ["add", "."]);
  sh(writer, ["commit", "-q", "-m", "fresh command"]);
  sh(writer, ["push", "-q", "origin", "dev"]);
  const wt3 = createWorktree(cfged, "sess-3");
  check("base is fetched: command pushed to origin AFTER clone appears in new worktree",
    fs.existsSync(path.join(wt3.path, ".claude/commands/fresh.md")));

  // 4. Explicit baseRef still wins over the config.
  const wt4 = createWorktree(cfged, "sess-4", "master");
  check("explicit baseRef overrides cockpit.baseref",
    !fs.existsSync(path.join(wt4.path, ".claude/commands/goodnight.md")));

  // 5. Operator writes the remote-qualified form — leading origin/ is stripped, still works.
  sh(cfged, ["config", "cockpit.baseref", "origin/dev"]);
  const wt5 = createWorktree(cfged, "sess-5");
  check("cockpit.baseref=origin/dev (remote-qualified) → still cut from dev",
    fs.existsSync(path.join(wt5.path, ".claude/commands/goodnight.md")));

  // 6. Offline: origin unreachable → fetch fails silently, stale origin/dev ref still used.
  sh(cfged, ["config", "cockpit.baseref", "dev"]);
  sh(cfged, ["remote", "set-url", "origin", path.join(ROOT, "gone.git")]);
  const wt6 = createWorktree(cfged, "sess-6");
  check("offline (origin unreachable) → launch still works from the stale origin/dev ref",
    fs.existsSync(path.join(wt6.path, ".claude/commands/goodnight.md")));

  // 7. Typo'd config must not brick launches: falls back to the default branch.
  const { repo: typo } = makeRepo();
  sh(typo, ["config", "cockpit.baseref", "no-such-branch"]);
  const wt7 = createWorktree(typo, "sess-7");
  check("typo'd cockpit.baseref → falls back to default branch instead of throwing",
    fs.existsSync(path.join(wt7.path, "base.txt")));

  // 8. Relaunch of an existing slug returns the same worktree (resolveBase never runs).
  const wt8 = createWorktree(typo, "sess-7");
  check("existing slug reused (no re-resolution of base)", wt8.path === wt7.path);

  return summary();
}

let code = 1;
try {
  code = main();
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
process.exit(code);
