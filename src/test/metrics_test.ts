/**
 * Overview "this session" metrics test. Locks in controller.metrics(): per-session context
 * (transcript bytes ÷ 4), cameBack (items surfaced), answered/median/avg reply-time from decided
 * items, age + since-last-reply, and the global session counts. Pure + deterministic.
 *
 * Standalone ring. Run: node dist/test/metrics_test.js
 */
import * as path from "path";
import * as fs from "fs";
import { tmpHome, check, eq, summary } from "./helpers";

// Throwaway HOME/DB/config BEFORE importing core (same discipline as the other rings).
const HOME = tmpHome();
process.env.HOME = HOME;
process.env.COCKPIT_DB = path.join(HOME, "cockpit.db");
process.env.COCKPIT_CONFIG_DIR = path.join(HOME, "config");
fs.mkdirSync(process.env.COCKPIT_CONFIG_DIR, { recursive: true });
for (const f of ["weights.json", "keymap.json"]) {
  fs.copyFileSync(path.resolve(__dirname, "../../config/" + f), path.join(process.env.COCKPIT_CONFIG_DIR, f));
}

import { openDb, setCompleted, allSessions } from "../core/db";
import { Controller } from "../core/controller";

const MIN = 60_000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
// SQLite datetime('now') shape ("YYYY-MM-DD HH:MM:SS", UTC, no T/Z) — what items.created_at holds.
const sqlAgo = (ms: number) => new Date(Date.now() - ms).toISOString().replace("T", " ").replace(/\..*$/, "");

function main() {
  console.log("\n== overview metrics (this-session stats) ==");
  const db = openDb();
  // Sessions rows must exist for the items FK (metrics() itself reads only the passed list).
  const insSess = db.prepare(
    "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch) VALUES (?,?,?,?,?,?)"
  );
  insSess.run(1, 1, "big run", "/demo", "/wt/1", "demo/1");
  insSess.run(2, 2, "fresh", "/demo", "/wt/2", "demo/2");
  // Completed sessions for the throughput (task-queue) stats. created_at/completed_at are
  // controlled so each lands in a known window: s3 done 30m ago (last hour), s4 done 5h ago
  // (24h window), s5 done 30h ago (all-time only; its start is also outside the 24h window).
  const HOUR = 60 * MIN;
  const insDone = db.prepare(
    "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?)"
  );
  insDone.run(3, 3, "ship feature", "/demo", "/wt/3", "demo/3", sqlAgo(3 * HOUR), sqlAgo(30 * MIN));
  insDone.run(4, 4, "older done", "/demo", "/wt/4", "demo/4", sqlAgo(26 * HOUR), sqlAgo(5 * HOUR));
  insDone.run(5, 5, "ancient done", "/demo", "/wt/5", "demo/5", sqlAgo(30 * HOUR), sqlAgo(30 * HOUR));
  // s9: completed 15h ago → lands in the PREVIOUS rolling 12h window (pace comparison).
  insDone.run(9, 9, "yesterday done", "/demo", "/wt/9", "demo/9", sqlAgo(16 * HOUR), sqlAgo(15 * HOUR));
  // Rows that must be EXCLUDED from throughput: auto-upserted pr cards, teammate sub-agents,
  // and idle-reaper 'auto' completions are not operator task flow.
  const insKind = db.prepare(
    "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch, kind, is_teammate, created_at, completed_at, completed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  insKind.run(6, 6, "pr card", "/demo", "/wt/6", "demo/6", "pr", 0, sqlAgo(10 * MIN), sqlAgo(10 * MIN), "operator");
  insKind.run(7, 7, "reviewer-r1", "/demo", "/wt/7", "demo/7", "claude", 1, sqlAgo(5 * MIN), null, null);
  insKind.run(8, 8, "idle reaped", "/demo", "/wt/8", "demo/8", "claude", 0, sqlAgo(26 * HOUR), sqlAgo(10 * MIN), "auto");

  // s10: old claude session (start outside every window) hosting the non-answer decisions below.
  insDone.run(10, 10, "old host", "/demo", "/wt/10", "demo/10", sqlAgo(26 * HOUR), null);

  // Tags for the doneByTag breakdown: a session counts once toward EACH of its tags — including
  // a duplicated tag in one array (COUNT DISTINCT) and ignoring non-string junk (j.type='text');
  // s9 stays untagged; tags on EXCLUDED rows (pr card s6, auto-reaped s8) must not count.
  const setTags = db.prepare("UPDATE sessions SET tags=? WHERE id=?");
  setTags.run('["training","gpu","gpu"]', 3); // duplicate gpu → still one session
  setTags.run('["ec2","gpu"]', 4);
  setTags.run('["data",7]', 5); // numeric junk element ignored; row is NOT untagged
  setTags.run('["ec2"]', 6); // pr card — excluded
  setTags.run('["ec2","gpu"]', 8); // auto-reaped — excluded

  let sig = 0;
  const insItem = db.prepare(
    "INSERT INTO items (session_id, state, status, decision, signature, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  );
  // decided items carry the real decision the UI writes: 'sent'/'ack' = answered; 'done'
  // (dismiss) and 'started' (card conversion) are decided but NOT answers.
  const add = (sid: number, status: string, createdMs: number, updatedMs: number, decision: string | null = status === "decided" ? "sent" : null) =>
    insItem.run(sid, "WAITING_INPUT", status, decision, `sig-${++sig}`, sqlAgo(createdMs), sqlAgo(updatedMs));
  // Session 1: 3 surfacings; 2 decided with queue waits of 30m and 90m → median 60m / avg 60m.
  add(1, "decided", 60 * MIN, 30 * MIN); // waited 30m, decision 'sent'
  add(1, "decided", 120 * MIN, 30 * MIN, "ack"); // waited 90m, FYI ack — also an answer
  add(1, "pending", 5 * MIN, 5 * MIN); // still pending
  // Session 2: surfaced once, never answered → reply stats should be null.
  add(2, "pending", 3 * MIN, 3 * MIN);
  // Decided item on the pr-kind session 6 → must NOT count as "answered" (join filters kind).
  add(6, "decided", 20 * MIN, 10 * MIN);
  // Dismissal + card-start on s10 @10m: decided but NOT answers (decision filter).
  add(10, "decided", 20 * MIN, 10 * MIN, "done");
  add(10, "decided", 20 * MIN, 10 * MIN, "started");

  // Big transcript for session 1's context proxy: 1.3 MB ÷ 4 = 325k tokens → red (>300k).
  const tpath = path.join(HOME, "s1.jsonl");
  fs.writeFileSync(tpath, "x".repeat(1_300_000));

  // metrics() only touches this.db + the passed sessions, so a stub engine/sessions/cfg is fine.
  const ctrl = new Controller(db, {} as any, {} as any, {} as any);
  const sessions = [
    { row: { id: 1, title: "big run", state: "WORKING", created_at: sqlAgo(5 * 60 * MIN), transcript_path: tpath } as any,
      lastActivity: isoAgo(10 * MIN), startedAt: isoAgo(5 * 60 * MIN) },
    { row: { id: 2, title: "fresh", state: "WAITING_INPUT", created_at: sqlAgo(20 * MIN), transcript_path: null } as any,
      lastActivity: isoAgo(2 * MIN), startedAt: isoAgo(20 * MIN) },
  ];
  const m = ctrl.metrics(sessions as any, 7);

  // ---- globals ----
  eq("totals.sessions", m.totals.sessions, 2);
  eq("totals.working", m.totals.working, 1);

  // ---- throughput (the "task queue" Overview panel) ----
  const t = m.throughput;
  eq("queuedNow passed through", t.queuedNow, 7);
  eq("completedTotal = 4 (operator claude tasks only — pr card + auto-reap excluded)", t.completedTotal, 4);
  eq("completedLastHour = 1 (s3 @30m; pr/auto @10m excluded)", t.completedLastHour, 1);
  eq("completed24h = 3 (s3 + s4 @5h + s9 @15h; s5 @30h out)", t.completed24h, 3);
  eq("startedLastHour = 2 (s1+s2; teammate s7 + pr s6 excluded)", t.startedLastHour, 2);
  eq("started24h = 4 (s1+s2+s3+s9; s4/s5/s8 too old, s6/s7 wrong kind)", t.started24h, 4);
  eq("answeredLastHour = 2 (s1's sent+ack @30m; pr item, dismissal + card-start excluded)", t.answeredLastHour, 2);
  eq("answered24h = 2", t.answered24h, 2);
  eq("completed12h = 2 (s3 + s4)", t.completed12h, 2);
  eq("completedPrev12h = 1 (s9 @15h)", t.completedPrev12h, 1);
  eq("hourly has 24 buckets", t.hourly.length, 24);
  check("hourly buckets are ascending hours", t.hourly.every((b, i) => i === 0 || b.hourStartMs - t.hourly[i - 1].hourStartMs === 3_600_000));
  eq("24h tiles ARE the bucket sums (chart and tiles can never disagree)",
    t.hourly.reduce((a, b) => a + b.completed, 0), t.completed24h);
  eq("hourly started sums to started24h", t.hourly.reduce((a, b) => a + b.started, 0), t.started24h);
  eq("current-hour bucket holds s3's completion… or the previous one (30m can straddle the wall-clock hour)",
    t.hourly[23].completed + t.hourly[22].completed, 1);
  eq("recentCompletions newest first", t.recentCompletions[0]?.title, "ship feature");
  eq("recentCompletions has the 4 operator completions", t.recentCompletions.length, 4);
  check("recentCompletions atMs ≈ 30m ago", Math.abs(Date.now() - t.recentCompletions[0].atMs - 30 * MIN) < 90_000);
  check("excluded rows never leak into recentCompletions",
    t.recentCompletions.every((c) => c.title !== "pr card" && c.title !== "idle reaped"));
  // doneByTag: gpu appears on s3+s4 → 2; data/ec2/training once each (n DESC, then tag asc);
  // s9 (untagged) lands in the dimmed bucket; s6/s8 tags excluded with their rows.
  eq("doneByTag order + counts", JSON.stringify(t.doneByTag),
    JSON.stringify([{ tag: "gpu", n: 2 }, { tag: "data", n: 1 }, { tag: "ec2", n: 1 }, { tag: "training", n: 1 }, { tag: "untagged", n: 1 }]));

  const s1 = m.sessions.find((s) => s.id === 1)!;
  const s2 = m.sessions.find((s) => s.id === 2)!;

  // ---- session 1: busy, bloated ----
  check("s1 present", !!s1);
  eq("s1 cameBack = 3 items", s1.cameBack, 3);
  eq("s1 answered = 2 decided", s1.answered, 2);
  eq("s1 median reply = 60m", s1.medianReplyMs, 60 * MIN);
  eq("s1 avg queue wait = 60m", s1.avgQueueWaitMs, 60 * MIN);
  eq("s1 context ≈ 325k tokens", s1.estTokens, 325_000);
  eq("s1 ctxLevel red (>300k)", s1.ctxLevel, "red");
  check("s1 working", s1.working === true);
  check("s1 age ≈ 5h", Math.abs(s1.ageMs - 5 * 60 * MIN) < 90_000);
  check("s1 sinceLast ≈ 10m", s1.sinceLastMs != null && Math.abs(s1.sinceLastMs - 10 * MIN) < 90_000);

  // ---- session 2: fresh, unanswered ----
  eq("s2 cameBack = 1 item", s2.cameBack, 1);
  eq("s2 answered = 0", s2.answered, 0);
  check("s2 median reply null (no decided items)", s2.medianReplyMs === null);
  check("s2 avg queue wait null", s2.avgQueueWaitMs === null);
  eq("s2 context 0 (no transcript)", s2.estTokens, 0);
  eq("s2 ctxLevel green", s2.ctxLevel, "green");
  check("s2 not working", s2.working === false);

  // ---- throughput edge cases: junk / future / ISO timestamps (fresh DB) ----
  console.log("\n== throughput edge cases (junk / future / ISO timestamps) ==");
  {
    const db2 = openDb(path.join(HOME, "edge.db"));
    const ins2 = db2.prepare(
      "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    // e1: junk created_at, never completed → must not crash, must count nowhere.
    ins2.run(1, 1, "junk start", "/demo", "/wt/1", "demo/1", "not-a-date", null);
    // e2: ISO completed_at (T/Z + millis) — completed_at is written as ISO in places while
    // created_at is SQLite-shaped; msOf must treat both identically.
    ins2.run(2, 2, "iso done", "/demo", "/wt/2", "demo/2", sqlAgo(10 * MIN), isoAgo(30 * MIN));
    // e3: completed_at 2h in the FUTURE → excluded from every window and bucket, but the row
    // still exists, so completedTotal (a row count) includes it.
    ins2.run(3, 3, "future done", "/demo", "/wt/3", "demo/3", sqlAgo(10 * MIN), sqlAgo(-2 * HOUR));
    // e4: junk completed_at → counted in completedTotal (row exists) but dropped from
    // recentCompletions (NaN atMs) and from all windows/buckets.
    ins2.run(4, 4, "junk done", "/demo", "/wt/4", "demo/4", "garbage", "also-garbage");
    // Items: only the valid decided-and-answered ('sent'/'ack') one may count as "answered".
    const insIt2 = db2.prepare(
      "INSERT INTO items (session_id, state, status, decision, signature, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    );
    insIt2.run(2, "WAITING_INPUT", "decided", "sent", "e-1", sqlAgo(40 * MIN), sqlAgo(20 * MIN)); // valid → counts
    insIt2.run(2, "WAITING_INPUT", "decided", "sent", "e-2", sqlAgo(40 * MIN), "bogus"); // junk stamp → skipped
    insIt2.run(2, "WAITING_INPUT", "decided", "ack", "e-3", sqlAgo(40 * MIN), sqlAgo(-3 * HOUR)); // future → skipped
    insIt2.run(2, "WAITING_INPUT", "pending", null, "e-4", sqlAgo(5 * MIN), sqlAgo(5 * MIN)); // not decided → not answered

    const ctrl2 = new Controller(db2, {} as any, {} as any, {} as any);
    const t2 = ctrl2.metrics([] as any).throughput;
    eq("queuedNow defaults to 0", t2.queuedNow, 0);
    eq("completedTotal counts rows even with junk/future stamps", t2.completedTotal, 3);
    eq("ISO completed_at parsed → completedLastHour = 1", t2.completedLastHour, 1);
    eq("future completion excluded → completed24h = 1 (ISO one only)", t2.completed24h, 1);
    eq("junk created_at skipped → startedLastHour = 2 (e2+e3)", t2.startedLastHour, 2);
    eq("started24h = 2", t2.started24h, 2);
    eq("answeredLastHour = 1 (junk + future + pending all skipped)", t2.answeredLastHour, 1);
    eq("answered24h = 1", t2.answered24h, 1);
    eq("hourly completed sum = 1 (junk/future never bucketed)", t2.hourly.reduce((a, b) => a + b.completed, 0), 1);
    eq("hourly started sum = 2", t2.hourly.reduce((a, b) => a + b.started, 0), 2);
    eq("hourly answered sum = 1", t2.hourly.reduce((a, b) => a + b.answered, 0), 1);
    eq("recentCompletions drops the junk stamp", t2.recentCompletions.length, 2);
    check("recentCompletions atMs all finite", t2.recentCompletions.every((c) => Number.isFinite(c.atMs)));
    check(
      "recentCompletions keeps the iso + future titles",
      ["iso done", "future done"].every((x) => t2.recentCompletions.some((c) => c.title === x))
    );
  }

  // ---- setCompleted: completed_by bookkeeping (default 'operator' / 'auto' / undo clears) ----
  console.log("\n== setCompleted — completed_by bookkeeping ==");
  {
    const db4 = openDb(path.join(HOME, "setcompleted.db"));
    const ins4 = db4.prepare(
      "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch, created_at) VALUES (?,?,?,?,?,?,?)"
    );
    ins4.run(1, 1, "operator task", "/demo", "/wt/1", "demo/1", sqlAgo(2 * HOUR));
    ins4.run(2, 2, "reaped task", "/demo", "/wt/2", "demo/2", sqlAgo(2 * HOUR));
    const row = (id: number) =>
      db4.prepare("SELECT completed_at, completed_by FROM sessions WHERE id=?").get(id) as any;

    // Default `by` is 'operator' — the Ctrl+G e / completeTask path passes nothing.
    setCompleted(db4, 1, isoAgo(30 * MIN));
    eq("setCompleted default attributes 'operator'", row(1).completed_by, "operator");
    check("setCompleted sets completed_at", row(1).completed_at != null);

    // Explicit 'auto' — the idle-reaper path.
    setCompleted(db4, 2, isoAgo(20 * MIN), "auto");
    eq("setCompleted(by='auto') records 'auto'", row(2).completed_by, "auto");

    // Throughput sees exactly the operator completion.
    const ctrl4 = new Controller(db4, {} as any, {} as any, {} as any);
    let t4 = ctrl4.metrics([] as any).throughput;
    eq("only the operator completion counts toward completedTotal", t4.completedTotal, 1);
    eq("recentCompletions holds the operator task only", t4.recentCompletions.length, 1);
    eq("…and it's the right one", t4.recentCompletions[0]?.title, "operator task");

    // Undo: at=null clears BOTH the stamp and the attribution — no stale 'auto' left behind.
    setCompleted(db4, 2, null);
    check("clearing completed_at nulls completed_by too",
      row(2).completed_at === null && row(2).completed_by === null);
    check("undone session is back in the roster (allSessions)",
      allSessions(db4).some((s: any) => s.id === 2));

    // Reopen → operator-complete: attribution flips and it now counts.
    setCompleted(db4, 2, isoAgo(5 * MIN));
    eq("re-completing after undo flips attribution to 'operator'", row(2).completed_by, "operator");
    t4 = ctrl4.metrics([] as any).throughput;
    eq("…and it now counts in throughput", t4.completedTotal, 2);
    check("completed rows are out of allSessions regardless of who completed them",
      allSessions(db4).length === 0);
  }

  // ---- 24h SQL-cutoff boundary: stamps just inside/outside the windowed-query cutoff ----
  console.log("\n== throughput 24h cutoff boundary (SQL pre-filter vs stored formats) ==");
  {
    // The windowed scans pre-filter with a SQLite-shaped cutoff string ("YYYY-MM-DD HH:MM:SS").
    // If that ever regresses to a raw ISO string (with 'T'/millis), SQLite-shaped stamps just
    // inside the window string-compare BELOW the cutoff and silently vanish from the tallies.
    // These rows are the tripwire: both stored formats, ~2min inside the 24h boundary, must
    // survive the SQL cutoff and land in the rolling prev-12h window (the only deterministic
    // observable near the boundary — bucket membership depends on the wall-clock minute).
    const db5 = openDb(path.join(HOME, "cutoff.db"));
    const ins5 = db5.prepare(
      "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    ins5.run(1, 1, "edge sql-shaped", "/demo", "/wt/1", "demo/1", sqlAgo(30 * HOUR), sqlAgo(23 * HOUR + 58 * MIN));
    ins5.run(2, 2, "edge iso-shaped", "/demo", "/wt/2", "demo/2", sqlAgo(30 * HOUR), isoAgo(23 * HOUR + 58 * MIN));
    // Just OUTSIDE: 24h02m old → excluded from every rolling window, but it's still a row
    // (completedTotal is COUNT(*)) and recents are all-time, so it stays visible there.
    ins5.run(3, 3, "stale by 2min", "/demo", "/wt/3", "demo/3", sqlAgo(30 * HOUR), sqlAgo(24 * HOUR + 2 * MIN));

    const ctrl5 = new Controller(db5, {} as any, {} as any, {} as any);
    const t5 = ctrl5.metrics([] as any).throughput;
    eq("both ~23h58m completions survive the cutoff → completedPrev12h = 2 (sql + iso shapes)", t5.completedPrev12h, 2);
    eq("completed12h stays 0 (they're in the older half of the day)", t5.completed12h, 0);
    const bsum = t5.hourly.reduce((a, b) => a + b.completed, 0);
    check("boundary rows bucket together or not at all; the >24h row NEVER buckets (sum 0 or 2)",
      bsum === 0 || bsum === 2);
    eq("completedTotal counts all three rows (COUNT(*) is unwindowed)", t5.completedTotal, 3);
    eq("recents are all-time: all three present", t5.recentCompletions.length, 3);
    eq("…with the >24h row last (DESC stamp order holds across formats)", t5.recentCompletions[2]?.title, "stale by 2min");
  }

  // ---- recentCompletions: >10 completions + junk stamps eating the LIMIT-10 buffer ----
  console.log("\n== recentCompletions with >10 completions (LIMIT-10 buffer → top 5) ==");
  {
    const db6 = openDb(path.join(HOME, "recents.db"));
    const ins6 = db6.prepare(
      "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    // 12 valid operator completions: done-1 is newest (1 min ago) … done-12 oldest.
    for (let i = 1; i <= 12; i++)
      ins6.run(i, i, `done-${i}`, "/demo", `/wt/${i}`, `demo/${i}`, sqlAgo(2 * HOUR), sqlAgo(i * MIN));
    // 3 junk-stamped completions whose strings sort ABOVE every real date in DESC order — they
    // occupy the top LIMIT slots, which is exactly why the query over-fetches 10 to show 5.
    // (Letters only: V8's lenient Date.parse turns digit-bearing junk like "zz-junk-0" into a
    // real epoch — these must stay NaN so the Number.isFinite filter is what drops them.)
    for (const j of ["a", "b", "c"])
      ins6.run(j.charCodeAt(0), 100 + j.charCodeAt(0), `junk-${j}`, "/demo", `/wt/j${j}`, `demo/j${j}`, sqlAgo(2 * HOUR), `zz-junk-${j}`);

    const ctrl6 = new Controller(db6, {} as any, {} as any, {} as any);
    const t6 = ctrl6.metrics([] as any).throughput;
    eq("top-5 stays full although 3 junk rows ate LIMIT-10 slots", t6.recentCompletions.length, 5);
    eq("…and it's exactly the 5 newest valid completions, newest first",
      t6.recentCompletions.map((c) => c.title).join(","), "done-1,done-2,done-3,done-4,done-5");
    check("no junk title leaks through", t6.recentCompletions.every((c) => !c.title.startsWith("junk-")));
    check("atMs strictly descending", t6.recentCompletions.every((c, i, a) => i === 0 || a[i - 1].atMs > c.atMs));
    eq("completedTotal counts junk-stamped rows too (COUNT(*), not the windowed scan)", t6.completedTotal, 15);
  }

  // ---- throughput on a completely empty DB → all zeros, 24 empty buckets, never NaN ----
  console.log("\n== throughput on an empty DB ==");
  {
    const db3 = openDb(path.join(HOME, "empty.db"));
    const ctrl3 = new Controller(db3, {} as any, {} as any, {} as any);
    const before = Math.floor(Date.now() / HOUR) * HOUR;
    const m3 = ctrl3.metrics([] as any); // no queuedNow arg → default
    const after = Math.floor(Date.now() / HOUR) * HOUR;
    const t3 = m3.throughput;
    eq("totals.sessions 0", m3.totals.sessions, 0);
    eq("queuedNow 0", t3.queuedNow, 0);
    eq("completedTotal 0", t3.completedTotal, 0);
    check(
      "all window counters are 0",
      [t3.startedLastHour, t3.completedLastHour, t3.answeredLastHour, t3.started24h, t3.completed24h, t3.answered24h]
        .every((x) => x === 0)
    );
    eq("hourly still has 24 buckets", t3.hourly.length, 24);
    check("every bucket is all-zero", t3.hourly.every((b) => b.started === 0 && b.completed === 0 && b.answered === 0));
    check(
      "last bucket aligned to the current wall-clock hour",
      t3.hourly[23].hourStartMs === before || t3.hourly[23].hourStartMs === after
    );
    eq("recentCompletions empty", t3.recentCompletions.length, 0);
    eq("doneByTag empty (no completions → no chips, no 'untagged 0')", t3.doneByTag.length, 0);
  }

  // ---- doneByTag: LIMIT-12 cap, duplicate tag in one array, '[]' untagged, filter drift ----
  console.log("\n== doneByTag edge cases (LIMIT 12 / duplicate tags / '[]' / filter drift) ==");
  {
    const db7 = openDb(path.join(HOME, "tags.db"));
    const ins7 = db7.prepare(
      "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch, kind, is_teammate, created_at, completed_at, completed_by, tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    // 14 distinct single-tag completions t01..t14 (all n=1 → ORDER BY n DESC, tag ASC decides).
    for (let i = 1; i <= 14; i++) {
      const tg = `t${String(i).padStart(2, "0")}`;
      ins7.run(i, i, `done ${tg}`, "/demo", `/wt/${i}`, `demo/${i}`, "claude", 0, sqlAgo(3 * HOUR), sqlAgo(2 * HOUR), "operator", `["${tg}"]`);
    }
    // s15: the SAME tag twice in one array — COUNT(DISTINCT s.id) counts the SESSION once, not
    // per occurrence (infraTags merges on top of enricher tags, so dupes are a realistic state).
    ins7.run(15, 15, "dup tags", "/demo", "/wt/15", "demo/15", "claude", 0, sqlAgo(3 * HOUR), sqlAgo(2 * HOUR), "operator", '["dup","dup"]');
    // s16: explicit '[]' (not just NULL, which the main ring covers) → the untagged bucket.
    ins7.run(16, 16, "empty tags", "/demo", "/wt/16", "demo/16", "claude", 0, sqlAgo(3 * HOUR), sqlAgo(2 * HOUR), "operator", "[]");
    // s17 tagged-but-LIVE and s18 tagged-but-TEAMMATE must not count: the tag query INLINES the
    // DONE filter instead of interpolating ${DONE} — these trip if the two ever drift apart.
    ins7.run(17, 17, "live tagged", "/demo", "/wt/17", "demo/17", "claude", 0, sqlAgo(3 * HOUR), null, null, '["live"]');
    ins7.run(18, 18, "teammate done", "/demo", "/wt/18", "demo/18", "claude", 1, sqlAgo(3 * HOUR), sqlAgo(2 * HOUR), "operator", '["mate"]');

    const t7 = new Controller(db7, {} as any, {} as any, {} as any).metrics([] as any).throughput;
    // 15 distinct tags compete for the 12 slots (all n=1 → tag ASC): dup, t01..t11; t12-t14
    // fall off the cap; "untagged" is appended AFTER the LIMIT so the cap can never squeeze
    // it out. dup is n=1 — a duplicated tag within one array counts the session ONCE.
    const expect7 = [
      { tag: "dup", n: 1 },
      ...Array.from({ length: 11 }, (_, i) => ({ tag: `t${String(i + 1).padStart(2, "0")}`, n: 1 })),
      { tag: "untagged", n: 1 },
    ];
    eq("LIMIT 12 + appended untagged (13 rows, dup counts once, t12-t14 dropped)",
      JSON.stringify(t7.doneByTag), JSON.stringify(expect7));
    check("live-session / teammate tags never leak in",
      t7.doneByTag.every((g) => g.tag !== "live" && g.tag !== "mate"));
  }

  // ---- doneByTag degrade path: malformed tags JSON must not take down throughput ----
  console.log("\n== doneByTag degrade path (malformed tags JSON on a completed row) ==");
  {
    const db8 = openDb(path.join(HOME, "badtags.db"));
    const ins8 = db8.prepare(
      "INSERT INTO sessions (id, slot, title, repo, worktree_path, branch, created_at, completed_at, tags) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    ins8.run(1, 1, "good tags", "/demo", "/wt/1", "demo/1", sqlAgo(3 * HOUR), sqlAgo(2 * HOUR), '["gpu"]');
    // Malformed tags on a DONE row → json_each throws inside the breakdown query (verified:
    // node:sqlite raises "malformed JSON") → the try/catch degrades doneByTag to [].
    ins8.run(2, 2, "bad tags", "/demo", "/wt/2", "demo/2", sqlAgo(3 * HOUR), sqlAgo(2 * HOUR), "not-json{");
    ins8.run(3, 3, "no tags", "/demo", "/wt/3", "demo/3", sqlAgo(2 * HOUR), sqlAgo(30 * MIN), null);

    let t8: any = null, threw = false;
    try {
      t8 = new Controller(db8, {} as any, {} as any, {} as any).metrics([] as any).throughput;
    } catch { threw = true; }
    check("throughput() never throws on malformed tags JSON (expected one [metrics] console.error above)", !threw);
    eq("doneByTag degrades to [] (whole breakdown, not a 500 / partial row)",
      JSON.stringify(t8?.doneByTag), "[]");
    // …and the REST of the snapshot is untouched by the degrade:
    eq("completedTotal still counts all 3", t8?.completedTotal, 3);
    eq("completedLastHour still sees the 30m completion", t8?.completedLastHour, 1);
    eq("completed24h unaffected", t8?.completed24h, 3);
    eq("recentCompletions still intact", t8?.recentCompletions.length, 3);
  }

  summary();
}
main();
