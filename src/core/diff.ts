/**
 * Git diff helpers for the REVIEW_DIFF view. Returns both a compact stat and the
 * full patch (the operator can always expand to raw).
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

export interface DiffInfo {
  changedLines: number;
  filesChanged: number;
  stat: string; // `git diff --stat`
  patch: string; // full unified diff
}

// P0: ASYNC git so opening a diff doesn't BLOCK the Node event loop (which froze the terminal
// for the git-diff duration). execFile yields; the terminal WS keeps flowing.
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const r = await execFileP("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return r.stdout as string;
  } catch {
    return "";
  }
}

export async function worktreeDiff(cwd: string): Promise<DiffInfo> {
  const stat = await git(cwd, ["diff", "--stat", "HEAD"]);
  const patch = await git(cwd, ["diff", "HEAD"]);
  let changedLines = 0;
  for (const line of patch.split("\n"))
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
      changedLines++;
  const filesChanged = (stat.match(/\|\s+\d+/g) || []).length;
  return { changedLines, filesChanged, stat: stat.trim(), patch };
}

/** True if `ref` resolves in this repo. */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  if (!ref) return false;
  try {
    await execFileP("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", ref + "^{commit}"], { encoding: "utf8" });
    return true;
  } catch { return false; }
}

/** The current branch name of a worktree (or "" if detached/unknown). */
export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/**
 * Resolve the BASE branch to diff a session's worktree against. Tries, in order:
 *   1. the configured default base (e.g. "main"), local or origin/<base>
 *   2. origin/HEAD (the repo's default branch)
 *   3. a recorded base the session was created from (passed in)
 *   4. "main" then "master"
 * Returns "" if nothing resolves. Never the branch itself.
 */
/** Ordered, existing base candidates (origin preferred over stale local), excluding the
 *  current branch. origin/HEAD is normalized to its target name. */
async function baseCandidates(cwd: string, configured: string, recordedBase?: string | null): Promise<string[]> {
  const cur = await currentBranch(cwd);
  const raw = [`origin/${configured}`, configured, "origin/HEAD", recordedBase || "", "origin/main", "main", "origin/master", "master"];
  const out: string[] = [];
  for (let c of raw) {
    if (!c) continue;
    if (c === "origin/HEAD") { c = (await git(cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"])).trim(); }
    if (!c || c === cur || out.includes(c)) continue;
    if (await refExists(cwd, c)) out.push(c);
  }
  return out;
}

export async function resolveBaseBranch(cwd: string, configured: string, recordedBase?: string | null): Promise<string> {
  return (await baseCandidates(cwd, configured, recordedBase))[0] || "";
}

/**
 * Diff a session's worktree against the MERGE-BASE of its base branch — i.e. "what THIS branch
 * changed since it diverged from main". We diff against `git merge-base <base> HEAD`
 * (two-dot to the WORKING tree, so committed + uncommitted changes are both included) instead of
 * the base TIP — immune to main moving ahead (no confusing reverse-diffs).
 * Returns the patch + resolved base/branch + short merge-base sha for the header.
 */
export async function branchVsBaseDiff(cwd: string, configuredBase: string, recordedBase?: string | null): Promise<{
  patch: string; stat: string; base: string; branch: string; changedLines: number; mergeBase: string;
}> {
  const branch = await currentBranch(cwd);
  const r = await resolveDiffAgainst(cwd, configuredBase, recordedBase);
  if (!r.against) return { patch: "", stat: "", base: "", branch, changedLines: 0, mergeBase: "" };
  const { against, base, mb } = r;
  const stat = await git(cwd, ["diff", "--stat", against]);
  const patch = await git(cwd, ["diff", against]);
  let changedLines = 0;
  for (const line of patch.split("\n"))
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
      changedLines++;
  return { patch, stat: stat.trim(), base, branch, changedLines, mergeBase: mb.slice(0, 7) };
}

/** Resolve the rev a session's worktree diffs AGAINST: merge-base of the first base candidate
 *  that shares history with HEAD (origin/<base> can be a divergent line), else the first
 *  candidate's tip. Shared by the full-patch view and per-file context expansion so both
 *  always diff against the SAME rev. */
export async function resolveDiffAgainst(cwd: string, configuredBase: string, recordedBase?: string | null): Promise<{
  against: string; base: string; mb: string;
}> {
  const candidates = await baseCandidates(cwd, configuredBase, recordedBase);
  if (!candidates.length) return { against: "", base: "", mb: "" };
  let base = candidates[0], mb = "";
  for (const c of candidates) {
    const m = (await git(cwd, ["merge-base", c, "HEAD"])).trim();
    if (m) { base = c; mb = m; break; }
  }
  return { against: mb || base, base, mb };
}

/**
 * One file's unified diff with `ctx` context lines (GitHub-style "expand context"): the
 * renderer swaps a file's default -U3 patch for this wider one when the operator clicks an
 * expand arrow. `against` is a single rev or an `a..b` range (git takes either as one arg);
 * a single rev two-dots to the WORKING tree, matching branchVsBaseDiff.
 */
export async function fileDiffWithContext(cwd: string, against: string, filePath: string, ctx: number, oldPath?: string): Promise<string> {
  const n = Math.max(0, Math.min(100000, Math.floor(ctx) || 0));
  // renames: include the OLD path in the pathspec too, else rename detection breaks and the
  // expanded cut becomes a misleading whole-file addition.
  const paths = oldPath && oldPath !== filePath ? [filePath, oldPath] : [filePath];
  // :(literal) pathspec magic: a filename containing glob chars (`*`, `[`, `?`) must match
  // itself, not act as a pattern (a glob can pull OTHER files into the cut → the renderer's
  // multi-file refusal). Controller-side input validation rejects `: `-prefixed user paths, so
  // this server-added prefix can't collide with operator input.
  const spec = paths.map((p) => `:(literal)${p}`);
  // STRICT git (no swallow, unlike git()): a failed spawn / bad rev / maxBuffer overflow on a
  // -U100000 whole-file cut must surface as an error, not masquerade as "no diff for this file".
  const r = await execFileP("git", ["diff", `-U${n}`, against, "--", ...spec], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.stdout as string;
}

/** One quiet, time-boxed `git fetch origin <refspec>`; true iff it succeeded. Explicit refspecs
 *  (`+refs/…:refs/…`) so tracking refs materialize even in --single-branch clones, and so a ref
 *  name can never be parsed as an option. */
async function tryFetch(repoPath: string, refspec: string): Promise<boolean> {
  try {
    await execFileP("git", ["fetch", "-q", "origin", refspec], { cwd: repoPath, encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch { return false; }
}

/**
 * The rev range matching what `gh pr diff` displays (merge-base "three-dot" content), resolved
 * in a LOCAL clone of the PR's repo. Fetch strategy (each best-effort, offline falls back to
 * whatever refs exist): base branch; then the PR's EXACT head via GitHub's `refs/pull/<n>/head`
 * (pinned to `refs/cockpit-pr/<n>` — fork-safe: a fork PR's bare head name could collide with an
 * unrelated same-named branch in the base repo); branch-name head only as fallback (non-GitHub
 * remotes). `fetchOk:false` = the head side couldn't be freshened → caller should warn the cut
 * may be stale. Returns range "" when nothing resolves.
 */
export async function prExpandRange(repoPath: string, base: string, head: string, prNumber: number, fetch: boolean): Promise<{ range: string; fetchOk: boolean }> {
  let fetchOk = true, pullFresh = !fetch; // no-fetch turns (throttle) inherit the last fetch's refs as-is
  if (fetch) {
    const baseOk = await tryFetch(repoPath, `+refs/heads/${base}:refs/remotes/origin/${base}`);
    const pullOk = prNumber > 0 && (await tryFetch(repoPath, `+refs/pull/${prNumber}/head:refs/cockpit-pr/${prNumber}`));
    const headOk = pullOk || (await tryFetch(repoPath, `+refs/heads/${head}:refs/remotes/origin/${head}`));
    fetchOk = baseOk && headOk;
    pullFresh = pullOk;
  }
  const headCands = [...(prNumber > 0 ? [`refs/cockpit-pr/${prNumber}`] : []), `origin/${head}`, head];
  for (const h of headCands) {
    if (!(await refExists(repoPath, h))) continue;
    for (const b of [`origin/${base}`, base]) {
      if (!(await refExists(repoPath, b))) continue;
      const mb = (await git(repoPath, ["merge-base", b, h])).trim();
      // serving a pinned pull ref the fetch FAILED to freshen = possibly stale, even if the
      // branch-name fetch succeeded — keep the pull ref preferred (fork-safety) but say so.
      const staleHead = h.startsWith("refs/cockpit-pr/") && !pullFresh;
      if (mb) return { range: `${mb}..${h}`, fetchOk: fetchOk && !staleHead };
    }
  }
  return { range: "", fetchOk };
}
