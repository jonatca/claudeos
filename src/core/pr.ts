/**
 * GitHub PR integration. Surfaces open PRs for the configured repos as cockpit items
 * (kind='pr', category REVIEW_DIFF) using the `gh` CLI (already authed as the operator).
 * The operator can read the diff and merge from the UI; merge is guarded behind a
 * confirm key because it is destructive / outward-facing.
 */
import { execFile, execFileSync } from "child_process";
import { DatabaseSync } from "node:sqlite";
import { SessionRow, upsertPr, pruneClosedPrs } from "./db";

export interface PrInfo {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  reviewDecision: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  headRef?: string; // the PR's head branch — used to dedup against a working session on the same branch
  baseRef?: string;
}

function gh(args: string[], timeoutMs = 20000): string {
  return execFileSync("gh", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
}

function ghAsync(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("gh", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => {
      resolve({ ok: !e, out: out || "", err: (err || "") + (e ? String(e.message || e) : "") });
    });
  });
}

/** Like ghAsync but runs IN a repo cwd so `gh` auto-detects the GitHub repo (no -R needed). */
function ghAsyncCwd(cwd: string, args: string[], timeoutMs = 30000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("gh", args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => {
      resolve({ ok: !e, out: out || "", err: (err || "") + (e ? String(e.message || e) : "") });
    });
  });
}

export interface SessionPr { number: number; url: string; title: string; state: string; mergeable: string; draft: boolean; base: string; head?: string; reviewDecision: string; }

/** FIX X: find the OPEN PR for a session's branch (run from its worktree so gh infers the repo).
 *  Returns the first open PR whose head is `branch`, or null. Best-effort (gh authed as operator). */
export async function prForBranch(cwd: string, branch: string): Promise<SessionPr | null> {
  if (!cwd || !branch) return null;
  const r = await ghAsyncCwd(cwd, [
    "pr", "list", "--head", branch, "--state", "open", "--json",
    "number,url,title,state,mergeStateStatus,isDraft,reviewDecision,baseRefName,headRefName",
  ], 20000);
  if (!r.ok) return null;
  try {
    const arr = JSON.parse(r.out) as any[];
    if (!Array.isArray(arr) || !arr.length) return null;
    const p = arr[0];
    return {
      number: p.number, url: p.url || "", title: p.title || `PR #${p.number}`,
      state: p.state || "OPEN", mergeable: p.mergeStateStatus || "", draft: !!p.isDraft,
      base: p.baseRefName || "", head: p.headRefName || "", reviewDecision: p.reviewDecision || "",
    };
  } catch { return null; }
}

/** MERGE-DEL: branches we refuse to delete no matter what the caller asks — deleting a mainline
 *  ref is never what "clean up the PR branch" means. Exported for unit testing. */
export function protectedBranch(branch: string | null | undefined): boolean {
  const b = (branch || "").trim();
  return !b || /^(master|main|dev|develop)$/i.test(b);
}

/** MERGE-DEL: ref path for the REST delete — PER-SEGMENT URL-encoded. gh api does not encode the
 *  endpoint, and git refnames may legally contain '#'/'%': "fix#123" would truncate the URL to
 *  .../heads/fix (deleting the WRONG branch), "master#x" would bypass protectedBranch().
 *  Exported for unit testing. */
export function branchRefPath(repoOrPlaceholder: string, branch: string): string {
  const enc = branch.split("/").map(encodeURIComponent).join("/");
  return `repos/${repoOrPlaceholder}/git/refs/heads/${enc}`;
}

/** MERGE-DEL: verify-then-delete the merged PR's head branch. The verification `gh pr view`
 *  (works on merged PRs) gives the AUTHORITATIVE head name and the cross-repository flag: a fork
 *  PR's bare head name ("patch-1") would otherwise be deleted in the BASE repo — possibly an
 *  unrelated same-named branch. Fails safe: can't verify → don't delete. */
async function deletePrHeadBranch(
  where: { repo?: string | null; cwd?: string | null }, prNumber: number, fallbackBranch: string | null
): Promise<{ ok: boolean; note: string }> {
  const args = ["pr", "view", String(prNumber), ...(where.repo ? ["-R", where.repo] : []), "--json", "headRefName,isCrossRepository"];
  const r = where.repo ? await ghAsync(args, 20000) : await ghAsyncCwd(where.cwd || ".", args, 20000);
  let head = fallbackBranch;
  if (r.ok) {
    try {
      const o = JSON.parse(r.out);
      if (o.isCrossRepository) return { ok: false, note: "head branch lives on a fork — not deleted" };
      head = o.headRefName || fallbackBranch;
    } catch { return { ok: false, note: "could not verify head branch — not deleted" }; }
  } else {
    return { ok: false, note: "could not verify head branch — not deleted" };
  }
  if (!head) return { ok: false, note: "could not determine head branch — not deleted" };
  return deleteRemoteBranch(where, head);
}

/** MERGE-DEL: delete a merged PR's REMOTE branch via the REST ref API — never `gh pr merge
 *  --delete-branch`, which also tries to checkout/delete the LOCAL branch and fails (or worse,
 *  switches branches) inside the session's worktree. Best-effort: GitHub's "auto-delete head
 *  branches" may have beaten us to it, which counts as done. */
async function deleteRemoteBranch(
  where: { repo?: string | null; cwd?: string | null }, branch: string
): Promise<{ ok: boolean; note: string }> {
  if (protectedBranch(branch)) return { ok: false, note: `refused to delete protected branch "${branch}"` };
  const path = branchRefPath(where.repo || "{owner}/{repo}", branch);
  const args = ["api", "-X", "DELETE", path];
  const r = where.repo ? await ghAsync(args, 20000) : await ghAsyncCwd(where.cwd || ".", args, 20000);
  if (r.ok) return { ok: true, note: `deleted branch ${branch}` };
  // ONLY the semantic "ref is gone" messages count as already-deleted — a bare /422|404/ match
  // would convert real failures (e.g. GitHub-side protected-branch refusal, also a 422) into
  // false success on exactly the case the guard above exists for.
  if (/Reference does not exist|HTTP 404/i.test(r.err)) return { ok: true, note: `branch ${branch} already deleted` };
  return { ok: false, note: `branch delete failed: ${r.err.slice(0, 200)}` };
}

/** FIX X: merge a PR by number from its worktree cwd (gh infers repo). Outward-facing — callers
 *  MUST confirm first. Returns the result + the exact command for transparency/logging.
 *  MERGE-DEL: deleteBranch removes the REMOTE head branch after a successful merge. */
export async function mergePrByNumber(
  cwd: string, prNumber: number, strategy: "merge" | "squash" | "rebase" = "squash",
  deleteBranch = false, branch: string | null = null
): Promise<{ ok: boolean; output: string; error?: string; cmd: string }> {
  const flag = strategy === "merge" ? "--merge" : strategy === "rebase" ? "--rebase" : "--squash";
  const args = ["pr", "merge", String(prNumber), flag];
  const cmd = `gh ${args.join(" ")}  (cwd=${cwd})`;
  const r = await ghAsyncCwd(cwd, args, 60000);
  let out = r.out;
  if (r.ok && deleteBranch) {
    // note goes FIRST — showMergeResult truncates the detail, and the deletion outcome is the
    // part the operator explicitly asked for
    const d = await deletePrHeadBranch({ cwd }, prNumber, branch);
    out = `${d.note}${out ? "\n" + out : ""}`;
  }
  return { ok: r.ok, output: out, error: r.ok ? undefined : r.err.slice(0, 600), cmd };
}

/** List open PRs for one repo. Returns null when gh fails (network/auth), so callers can tell
 *  "no open PRs" from "listing unavailable" — pruning/untagging on a failed listing would wipe
 *  every PR card for the repo until the next good scan. */
export function listOpenPrs(repo: string): PrInfo[] | null {
  try {
    const out = gh([
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,author,updatedAt,url,additions,deletions,isDraft,reviewDecision,headRefName,baseRefName",
    ]);
    const arr = JSON.parse(out) as any[];
    return arr.map((p) => ({
      repo,
      number: p.number,
      title: p.title || `PR #${p.number}`,
      url: p.url || "",
      author: (p.author && (p.author.login || p.author.name)) || "",
      updatedAt: p.updatedAt || "",
      reviewDecision: p.reviewDecision || "",
      isDraft: !!p.isDraft,
      additions: p.additions || 0,
      deletions: p.deletions || 0,
      headRef: p.headRefName || "",
      baseRef: p.baseRefName || "",
    }));
  } catch {
    return null;
  }
}

/** Pure dedup match: does an existing working (kind='claude') session already cover this PR's
 *  branch? Such a session already renders the PR diff + merge button, so we must NOT also create a
 *  standalone pr-card for it. Matches on branch name AND that the session's local repo basename
 *  matches the PR's GitHub repo name (so "task/foo" in two repos can't cross-match). Returns the
 *  owning session id, or null. Exported for unit testing without a live `gh`. */
export function prBranchOwner(
  pr: { repo: string; headRef?: string | null },
  sessions: { id: number; branch: string | null; repo: string | null }[]
): number | null {
  const head = (pr.headRef || "").trim();
  if (!head) return null;
  const prRepoName = (pr.repo.split("/").pop() || "").toLowerCase();
  for (const s of sessions) {
    if (!s.branch || s.branch.trim() !== head) continue;
    const sRepoName = (s.repo || "").replace(/\/+$/, "").split("/").pop()?.toLowerCase() || "";
    // repo guard is best-effort: if we can't read the session repo, fall back to a branch-only match
    if (!sRepoName || !prRepoName || sRepoName === prRepoName) return s.id;
  }
  return null;
}

/** PR-TERMINAL: resolve the operator's LOCAL clone of a GitHub repo ("owner/name") from the
 *  configured candidate paths (kanban_repo / sessions_repos) by basename match. Pure, exported
 *  for unit testing. Returns the first matching path, or null (no local clone configured). */
export function localRepoForPr(prRepo: string, candidates: (string | null | undefined)[]): string | null {
  const name = (prRepo.split("/").pop() || "").trim().toLowerCase();
  if (!name) return null;
  for (const c of candidates) {
    if (!c) continue;
    const base = c.replace(/\/+$/, "").split("/").pop()?.toLowerCase() || "";
    if (base === name) return c;
  }
  return null;
}

/** PR-TERMINAL: the seed prompt a PR card's terminal boots with — full PR context up front, so
 *  the session is "aware of which PR we are talking about" and ready to answer questions instead
 *  of starting work. Pure builder, exported for unit testing. */
export function prSeedPrompt(s: {
  pr_repo?: string | null; pr_number?: number | null; title?: string | null;
  pr_head_ref?: string | null; pr_base_ref?: string | null; pr_author?: string | null;
  pr_additions?: number | null; pr_deletions?: number | null;
  pr_review_decision?: string | null; pr_draft?: number | null; pr_url?: string | null;
}): string {
  const n = s.pr_number, repo = s.pr_repo || "";
  const head = s.pr_head_ref || "?", base = s.pr_base_ref || "?";
  const facts = [
    `branch ${head} → ${base}`,
    s.pr_author ? `author ${s.pr_author}` : "",
    `+${s.pr_additions ?? 0}/−${s.pr_deletions ?? 0}`,
    s.pr_review_decision ? `review: ${s.pr_review_decision}` : "",
    s.pr_draft ? "DRAFT" : "",
  ].filter(Boolean).join(" · ");
  return [
    `You are the operator's interactive terminal for GitHub PR #${n} in ${repo} — "${(s.title || "").trim()}".`,
    `PR context: ${facts}${s.pr_url ? ` · ${s.pr_url}` : ""}`,
    `This worktree is checked out on the PR's head branch (${head}), so the code you see IS the PR.`,
    `For more detail use: gh pr view ${n} -R ${repo} · gh pr diff ${n} -R ${repo} · git log --oneline origin/${base}..HEAD`,
    `First, skim the PR's changes and give a 2-4 line orientation summary of what it does.`,
    `Then STOP and wait for the operator's questions. Do NOT modify code, commit, push, comment, or merge unless the operator explicitly asks.`,
  ].join("\n");
}

/** PR-TERMINAL dedup: a claude session already TAGGED with this exact PR (pr_repo + pr_number)
 *  owns it — regardless of its branch. A materialized PR terminal whose head branch was busy gets
 *  a DETACHED worktree, and discovery then records its branch as the literal "HEAD", so the
 *  branch-based prBranchOwner match misses it and the scan would re-card the PR it already owns.
 *  Exported for unit testing. */
export function prTaggedOwner(db: DatabaseSync, pr: { repo: string; number: number }): number | null {
  // completed sessions can't own a PR: a tagged-but-completed session is hidden from the queue,
  // so letting it claim ownership makes the still-open PR invisible (no standalone card either).
  const r = db
    .prepare("SELECT id FROM sessions WHERE kind='claude' AND pr_repo=? AND pr_number=? AND completed_at IS NULL ORDER BY id DESC LIMIT 1")
    .get(pr.repo, pr.number) as { id: number } | undefined;
  return r ? r.id : null;
}

/** Scan all configured repos and upsert their open PRs; prune PRs that closed.
 *  DEDUP: a PR whose branch is already owned by a working session is NOT given its own pr-card —
 *  instead the owning session is tagged with the PR (so it shows in PR/merge mode and gets the
 *  min-priority floor), and any previously-created standalone card for it is pruned. */
export function scanPrs(db: DatabaseSync, repos: string[]): number {
  const claudeSessions = db
    .prepare(
      "SELECT id, branch, repo FROM sessions WHERE kind='claude' AND branch IS NOT NULL AND branch != '' AND completed_at IS NULL"
    )
    .all() as unknown as { id: number; branch: string | null; repo: string | null }[];
  const openKeys = new Set<string>();
  const allOpen = new Set<string>(); // every open PR, including owner-claimed ones (untag check)
  const okRepos: string[] = []; // repos whose gh listing succeeded — only these prune/untag
  let n = 0;
  for (const repo of repos) {
    const prs = listOpenPrs(repo);
    if (prs == null) continue; // gh failed — leave this repo's cards/tags untouched this round
    okRepos.push(repo);
    for (const pr of prs) {
      allOpen.add(`pr:${pr.repo}#${pr.number}`);
      // Branch match first (a session ACTIVELY on the PR's head branch is the freshest owner),
      // then the tag fallback (covers materialized PR terminals on a DETACHED checkout, whose
      // branch reads "HEAD"). Tag-first would let a stale tagged row out-claim a new session
      // that genuinely owns the branch.
      const ownerId = prBranchOwner(pr, claudeSessions) ?? prTaggedOwner(db, pr);
      if (ownerId != null) {
        // Tag the owning session with the PR; do NOT add to openKeys, so pruneClosedPrs removes any
        // stale standalone pr-card. The min-priority floor is applied to this session in scoreFor().
        // pr_base_ref too: diffExpand's PR path needs BOTH refs — without it every PR-attached
        // claude session refuses expansion with "retry after the next PR scan" forever.
        db.prepare("UPDATE sessions SET pr_repo=?, pr_number=?, pr_head_ref=?, pr_base_ref=? WHERE id=?")
          .run(pr.repo, pr.number, pr.headRef || null, pr.baseRef || null, ownerId);
        continue;
      }
      upsertPr(db, pr);
      openKeys.add(`pr:${pr.repo}#${pr.number}`);
      n++;
    }
  }
  pruneClosedPrs(db, openKeys, okRepos);
  // UNTAG claude sessions whose PR merged/closed: the tag drives the PR badge + merge button +
  // min-priority floor, all of which must track OPEN PRs only. Scoped to repos whose listing
  // SUCCEEDED (a gh hiccup or a repo removed from pr_repos leaves tags alone).
  const tagged = db
    .prepare("SELECT id, pr_repo, pr_number FROM sessions WHERE kind='claude' AND pr_repo IS NOT NULL AND pr_number IS NOT NULL")
    .all() as unknown as { id: number; pr_repo: string; pr_number: number }[];
  for (const t of tagged) {
    if (!okRepos.includes(t.pr_repo)) continue;
    if (!allOpen.has(`pr:${t.pr_repo}#${t.pr_number}`)) {
      db.prepare("UPDATE sessions SET pr_repo=NULL, pr_number=NULL, pr_head_ref=NULL, pr_base_ref=NULL WHERE id=?").run(t.id);
    }
  }
  return n;
}

/** PR-CONV: the full "GitHub PR page" pull for the diff view's redesigned header + Conversation
 *  tab — PR meta (opened/last-commit ages), the cockpit review runs (/pr + /prteam), and the
 *  conversation timeline (issue comments, review verdicts, inline file threads, commits).
 *  Two gh calls in parallel; the inline-comment call is best-effort (a failure must not nuke
 *  the rest of the timeline). Resolve the repo explicitly (`repo`) or from a worktree (`cwd`). */
export async function fetchPrConversation(opts: { repo?: string | null; cwd?: string | null; number: number }): Promise<any> {
  const n = opts.number;
  // never fall back to the server's own cwd — `gh pr view <n>` would resolve PR #n of whatever
  // repo the server happens to live in and show an unrelated PR's conversation
  if (!opts.repo && !opts.cwd) return { ok: false, error: "no repo context for this PR" };
  const viewArgs = [
    "pr", "view", String(n), ...(opts.repo ? ["-R", opts.repo] : []), "--json",
    "number,createdAt,commits,comments,reviews,reviewDecision,state,isDraft,additions,deletions,title,url,author,baseRefName,headRefName,mergeStateStatus",
  ];
  // `gh pr view` does NOT include inline review comments — REST does. {owner}/{repo} placeholders
  // resolve from the cwd's repo when no explicit repo is configured. per_page=100 instead of
  // --paginate: paginate concatenates JSON arrays (unparseable), and >100 inline comments is
  // beyond what the timeline needs anyway.
  const apiPath = `repos/${opts.repo || "{owner}/{repo}"}/pulls/${n}/comments?per_page=100`;
  const run = (args: string[]) => (opts.repo ? ghAsync(args, 30000) : ghAsyncCwd(opts.cwd!, args, 30000));
  const [vr, ir] = await Promise.all([run(viewArgs), run(["api", apiPath])]);
  if (!vr.ok) return { ok: false, error: vr.err.slice(0, 400) };
  let o: any;
  try { o = JSON.parse(vr.out); } catch (e: any) { return { ok: false, error: "parse error: " + String(e?.message || e) }; }
  let inline: any[] = [];
  if (ir.ok) { try { const a = JSON.parse(ir.out); if (Array.isArray(a)) inline = a; } catch {} }

  const { parseCockpitMarkers, parseLooseReviewRuns, parseReviewRuns } = require("./pr_comments");
  const thread: any[] = [];

  // Commits as compact timeline dots (makes "last commit 2h ago" inspectable). Newest tail only.
  const commits: any[] = Array.isArray(o.commits) ? o.commits : [];
  for (const c of commits.slice(-50)) {
    thread.push({
      kind: "commit", oid: String(c.oid || "").slice(0, 7), headline: c.messageHeadline || "",
      author: (c.authors && c.authors[0] && (c.authors[0].login || c.authors[0].name)) || "",
      createdAt: c.committedDate || c.authoredDate || "",
    });
  }
  // Issue comments. Cockpit-tagged (/pr, /prteam) ones get a structured badge and the hidden
  // marker line stripped (parseCockpitMarkers already returns the post-marker summary); LOOSE
  // (marker-less) prteam comments get a badge too, with the verdict left unknown.
  for (const c of o.comments || []) {
    const author = (c.author && (c.author.login || c.author.name)) || "";
    const tagged = parseCockpitMarkers([c]);
    const loose = tagged.length ? [] : parseLooseReviewRuns([c]);
    if (tagged.length) {
      const r = tagged[0];
      thread.push({ kind: "comment", author, createdAt: c.createdAt || "", body: r.summary,
        cockpit: { type: r.type, verdict: r.verdict, tier: r.tier, rounds: r.rounds, tests: r.tests } });
    } else if (loose.length) {
      thread.push({ kind: "comment", author, createdAt: c.createdAt || "", body: String(c.body || "").slice(0, 4000),
        cockpit: { type: "prteam", verdict: "", tier: "", rounds: "", tests: "" } });
    } else {
      thread.push({ kind: "comment", author, createdAt: c.createdAt || "", body: String(c.body || "").slice(0, 4000) });
    }
  }
  // Review verdicts (approve / request-changes / commented-with-body). Body-less COMMENTED rows
  // are GitHub's phantom containers for inline comments — those surface as threads below instead.
  for (const r of o.reviews || []) {
    const state = String(r.state || "").toUpperCase();
    if (state === "PENDING") continue;
    if (!String(r.body || "").trim() && state === "COMMENTED") continue;
    thread.push({ kind: "review", author: (r.author && r.author.login) || "", createdAt: r.submittedAt || "",
      state, body: String(r.body || "").slice(0, 4000) });
  }
  // Inline review comments → file threads grouped by reply-root (REST review ids don't match
  // gh's GraphQL review objects, so root-grouping is the reliable join).
  const byId = new Map<number, any>(inline.map((c: any) => [c.id, c]));
  const rootOf = (c: any) => {
    let cur = c; const seen = new Set<number>();
    while (cur.in_reply_to_id && byId.has(cur.in_reply_to_id) && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.in_reply_to_id); }
    return cur;
  };
  const groups = new Map<number, any[]>();
  for (const c of inline) { const root = rootOf(c); const g = groups.get(root.id) || []; g.push(c); groups.set(root.id, g); }
  for (const [rootId, cs] of groups) {
    cs.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    const root = byId.get(rootId) || cs[0];
    thread.push({
      kind: "thread", path: root.path || "", line: root.line || root.original_line || null,
      author: (root.user && root.user.login) || "", createdAt: root.created_at || "",
      comments: cs.map((c: any) => ({ author: (c.user && c.user.login) || "", createdAt: c.created_at || "", body: String(c.body || "").slice(0, 2000) })),
    });
  }
  thread.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));

  const lastCommitAt = commits.length
    ? commits.map((c: any) => c.committedDate || c.authoredDate || "").sort().pop() || null
    : null;
  return {
    ok: true,
    pr: {
      number: o.number ?? n, url: o.url || "", title: o.title || "", state: o.state || "OPEN",
      draft: !!o.isDraft, reviewDecision: o.reviewDecision || "", mergeable: o.mergeStateStatus || "",
      additions: o.additions || 0, deletions: o.deletions || 0,
      author: (o.author && (o.author.login || o.author.name)) || "",
      base: o.baseRefName || "", head: o.headRefName || "", createdAt: o.createdAt || "",
    },
    meta: { createdAt: o.createdAt || "", lastCommitAt, commitCount: commits.length },
    reviews: parseReviewRuns(o.comments || []),
    thread,
  };
}

/** Fetch the PR's comments and parse the cockpit-tagged /pr and /prteam review runs. */
export async function prReviewRuns(session: SessionRow): Promise<{ ok: boolean; runs: any[]; error?: string }> {
  if (!session.pr_repo || !session.pr_number) return { ok: false, runs: [], error: "not a PR" };
  const r = await ghAsync(["pr", "view", String(session.pr_number), "-R", session.pr_repo, "--json", "comments"]);
  if (!r.ok) return { ok: false, runs: [], error: r.err.slice(0, 400) };
  try {
    const { parseReviewRuns } = require("./pr_comments");
    const o = JSON.parse(r.out);
    return { ok: true, runs: parseReviewRuns(o.comments || []) }; // tagged markers + loose prteam fallback
  } catch (e: any) {
    return { ok: false, runs: [], error: String(e?.message || e) };
  }
}

export async function prDiff(session: SessionRow): Promise<{ ok: boolean; diff: string; error?: string }> {
  if (!session.pr_repo || !session.pr_number) return { ok: false, diff: "", error: "not a PR" };
  const r = await ghAsync(["pr", "diff", String(session.pr_number), "-R", session.pr_repo]);
  if (!r.ok) return { ok: false, diff: "", error: r.err.slice(0, 400) };
  return { ok: true, diff: r.out };
}

/** Live PR status (review decision + check rollup). */
export async function prStatus(
  session: SessionRow
): Promise<{ ok: boolean; reviewDecision: string; checks: string; state: string; error?: string }> {
  if (!session.pr_repo || !session.pr_number)
    return { ok: false, reviewDecision: "", checks: "", state: "", error: "not a PR" };
  const r = await ghAsync([
    "pr",
    "view",
    String(session.pr_number),
    "-R",
    session.pr_repo,
    "--json",
    "reviewDecision,statusCheckRollup,state",
  ]);
  if (!r.ok) return { ok: false, reviewDecision: "", checks: "", state: "", error: r.err.slice(0, 400) };
  try {
    const o = JSON.parse(r.out);
    const rollup = Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : [];
    const fail = rollup.filter((c: any) => (c.conclusion || c.state) && /FAIL|ERROR/i.test(c.conclusion || c.state)).length;
    const pass = rollup.filter((c: any) => /SUCCESS|PASS/i.test(c.conclusion || c.state || "")).length;
    const pending = rollup.length - fail - pass;
    const checks = rollup.length ? `${pass}✓ ${fail}✗ ${pending}…` : "no checks";
    return { ok: true, reviewDecision: o.reviewDecision || "", checks, state: o.state || "" };
  } catch {
    return { ok: false, reviewDecision: "", checks: "", state: "", error: "parse error" };
  }
}

/** Merge a PR. Destructive / outward-facing — callers must confirm first.
 *  MERGE-DEL: deleteBranch removes the REMOTE head branch (pr_head_ref) after a clean merge. */
export async function prMerge(
  session: SessionRow,
  method: "merge" | "squash" | "rebase" = "squash",
  deleteBranch = false
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (!session.pr_repo || !session.pr_number) return { ok: false, output: "", error: "not a PR" };
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
  const r = await ghAsync(["pr", "merge", String(session.pr_number), "-R", session.pr_repo, flag], 60000);
  let out = r.out;
  if (r.ok && deleteBranch) {
    const d = await deletePrHeadBranch({ repo: session.pr_repo }, session.pr_number, session.pr_head_ref || null);
    out = `${d.note}${out ? "\n" + out : ""}`;
  }
  return { ok: r.ok, output: out, error: r.ok ? undefined : r.err.slice(0, 600) };
}
