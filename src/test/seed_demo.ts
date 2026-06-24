/**
 * Seed a demo database with mock sessions in mixed states so the Electron UI can be
 * driven by hand. Writes to ./data/cockpit.db (the default the app reads). Re-runnable.
 *
 *   npm run demo        # populate
 *   npm start           # launch the UI against it
 */
import * as path from "path";
import * as fs from "fs";
import { writeTranscript, makeRepoWithDiff } from "./helpers";

// Use the app's real data dir + config; transcripts under the real HOME so the app finds them.
const dataDir = path.resolve(__dirname, "../../data");
process.env.COCKPIT_DB = process.env.COCKPIT_DB || path.join(dataDir, "cockpit.db");

// Start from a clean slate so the demo is reproducible regardless of prior runs.
const root = path.join(dataDir, "demo-worktrees");
fs.rmSync(root, { recursive: true, force: true });
for (const f of ["cockpit.db", "cockpit.db-wal", "cockpit.db-shm"])
  fs.rmSync(path.join(dataDir, f), { force: true });
fs.mkdirSync(root, { recursive: true });

import { openDb } from "../core/db";
import { SessionManager } from "../core/sessions";

const db = openDb();
const sm = new SessionManager(db);

function mock(name: string, title: string, lines: any[], opts: any = {}, changed = 0) {
  const cwd = path.join(root, name);
  if (changed) makeRepoWithDiff(cwd, changed);
  else fs.mkdirSync(cwd, { recursive: true });
  writeTranscript(cwd, lines);
  return sm.register({ repo: "/repo/demo", title, worktreePath: cwd, branch: "cockpit/" + name, blocksOtherWork: opts.blocks, deadline: opts.deadline });
}

mock("running-reindex", "full-table reindex job", [{ role: "assistant", text: "Launching the reindex", stop_reason: "tool_use", toolUse: true }]);
mock("server-port", "wire up worker health port", [{ role: "assistant", text: "Should I bind the health endpoint to port 8080? (yes/no)" }]);
mock("cache-arch", "design the cache layer", [{ role: "assistant", text: "Three caching approaches, real trade-offs:\n- Option A: in-process LRU (simplest, not shared)\n- Option B: Redis (shared, extra ops)\n- Option C: mmap file cache (fast+shared, more code)\nWhich do you want?" }], { blocks: true });
mock("refactor-importer", "refactor the CSV importer", [{ role: "assistant", text: "The importer refactor is ready for review — please review the diff before I open the PR." }], {}, 22);
mock("nightly-tests", "nightly test-suite run", [{ role: "assistant", text: "result: nightly test-suite done — 1843 passed, 0 failed, coverage 92%" }]);
mock("scratch", "scratch notes", [{ role: "assistant", text: "Okay, noted." }]);
mock("ffmpeg-job", "transcode batch", [{ role: "assistant", text: "failed: required binary ffmpeg is not installed on this host" }]);
mock("deadline-task", "customer export (due soon)", [{ role: "assistant", text: "Should I include the unviewed rows in the export? (yes/no)" }], { deadline: new Date(Date.now() + 6 * 3.6e6).toISOString() });

console.log("seeded demo db at", process.env.COCKPIT_DB);
console.log("now run:  npm start   (or npm run start:xvfb on a headless box)");
