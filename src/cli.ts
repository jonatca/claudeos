/**
 * ClaudeOS CLI — manage the sessions ClaudeOS watches. Writes to the same
 * data/cockpit.db the Electron app reads.
 *
 *   node dist/cli.js launch   <repo> <title> <prompt...>     # new isolated worktree + Claude Code session
 *   node dist/cli.js register <repo> <title> <worktree> <branch>  # watch an already-running session
 *   node dist/cli.js list                                    # show known sessions + live state
 */
import * as fs from "fs";
import * as path from "path";
import { openDb, allSessions, purgeDemoArtifacts } from "./core/db";
import { SessionManager } from "./core/sessions";

function requireGitRepo(repo: string): string {
  const abs = path.resolve(repo);
  if (!fs.existsSync(abs)) {
    console.error(`error: repo path does not exist: ${abs}\n(give a real path to a git repository, e.g. ~/code/my-project)`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(abs, ".git"))) {
    console.error(`error: not a git repository (no .git): ${abs}`);
    process.exit(2);
  }
  return abs;
}

function usage(): never {
  console.log(
    `ClaudeOS CLI
  launch   <repo> <title> <prompt...>
  register <repo> <title> <worktreePath> <branch>
  list`
  );
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const db = openDb();
const sm = new SessionManager(db);

if (cmd === "launch") {
  const [repo, title, ...promptParts] = rest;
  if (!repo || !title || !promptParts.length) usage();
  const id = sm.launch({ repo: requireGitRepo(repo), title, prompt: promptParts.join(" ") });
  const s = sm.list().find((x) => x.id === id)!;
  console.log(`launched session #${s.slot} "${title}"`);
  console.log(`  worktree: ${s.worktree_path}`);
  console.log(`  attach:   ${sm.attachCommand(s)}`);
} else if (cmd === "register") {
  const [repo, title, worktreePath, branch] = rest;
  if (!repo || !title || !worktreePath || !branch) usage();
  const id = sm.register({ repo: requireGitRepo(repo), title, worktreePath: path.resolve(worktreePath), branch });
  console.log(`registered session #${id} "${title}" -> ${worktreePath}`);
} else if (cmd === "list") {
  for (const s of allSessions(db))
    console.log(`#${s.slot}\t${s.state.padEnd(14)}\t${s.title}\t${s.worktree_path}`);
} else if (cmd === "purge-demo") {
  const r = purgeDemoArtifacts(db);
  console.log(`purged ${r.sessions} stale demo-worktrees sessions and ${r.projectDirs} transcript dirs`);
} else {
  usage();
}
