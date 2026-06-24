/**
 * Undo stack — lets the operator revert their last action(s). Every reversible
 * controller action pushes a record whose `ops` say exactly how to reverse it; undo()
 * pops the newest and applies them. Fully transparent, all in SQLite.
 *
 * Op kinds:
 *   setItem    {table:'items',    id, fields:{...}}   -> UPDATE … SET fields WHERE id
 *   setSession {table:'sessions', id, fields:{...}}   -> UPDATE … SET fields WHERE id
 *   delDecisionLog {id}                               -> DELETE FROM decision_log WHERE id
 *   bump {key, delta}                                 -> reverse a learned score nudge
 *   bumpView {category, rawDelta, ctxDelta}           -> reverse a learned view nudge
 */
import { DatabaseSync } from "node:sqlite";

export type UndoOp =
  | { t: "setItem"; id: number; fields: Record<string, any> }
  | { t: "setSession"; id: number; fields: Record<string, any> }
  | { t: "delDecisionLog"; id: number }
  | { t: "delAnswerFeedback"; id: number }
  | { t: "bump"; key: string; delta: number }
  | { t: "bumpView"; category: string; rawDelta: number; ctxDelta: number }
  | { t: "moveFile"; from: string; toDir: string };

const KEEP = 20; // keep at least the last ~20 actions

export function pushUndo(db: DatabaseSync, action: string, label: string, ops: UndoOp[]): void {
  db.prepare("INSERT INTO undo_stack (action, label, ops) VALUES (?,?,?)").run(action, label, JSON.stringify(ops));
  // trim old records beyond KEEP
  db.prepare(
    `DELETE FROM undo_stack WHERE id NOT IN (SELECT id FROM undo_stack ORDER BY id DESC LIMIT ${KEEP})`
  ).run();
}

export function peekUndo(db: DatabaseSync): { id: number; action: string; label: string } | null {
  const r = db.prepare("SELECT id, action, label FROM undo_stack ORDER BY id DESC LIMIT 1").get() as
    | { id: number; action: string; label: string }
    | undefined;
  return r ?? null;
}

export function undoCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) c FROM undo_stack").get() as { c: number }).c;
}

function applyOp(db: DatabaseSync, op: UndoOp): void {
  switch (op.t) {
    case "setItem":
    case "setSession": {
      const table = op.t === "setItem" ? "items" : "sessions";
      const keys = Object.keys(op.fields);
      if (!keys.length) return;
      const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(", ")}, updated_at=datetime('now') WHERE id=?`;
      db.prepare(sql).run(...keys.map((k) => op.fields[k]), op.id);
      break;
    }
    case "delDecisionLog":
      db.prepare("DELETE FROM decision_log WHERE id=?").run(op.id);
      break;
    case "delAnswerFeedback":
      db.prepare("DELETE FROM answer_feedback WHERE id=?").run(op.id);
      break;
    case "bump":
      // reverse a clamped nudge (best-effort; clamp matches feedback.ts)
      db.prepare(
        `UPDATE signal_adjustments SET adjustment = MAX(-40, MIN(40, adjustment + ?)), updated_at=datetime('now') WHERE key=?`
      ).run(op.delta, op.key);
      break;
    case "bumpView":
      db.prepare(
        `UPDATE view_pref SET raw_pref = raw_pref + ?, context_pref = context_pref + ?, updated_at=datetime('now') WHERE category=?`
      ).run(op.rawDelta, op.ctxDelta, op.category);
      break;
    case "moveFile": {
      // FIX J undo: move a kanban card back to its previous column (reverse of the complete move).
      try { const { moveCardFile } = require("./kanban"); moveCardFile(op.from, op.toDir); } catch {}
      break;
    }
  }
}

/** Pop and reverse the most recent action. Returns its label, or null if nothing to undo. */
export function undo(db: DatabaseSync): { label: string; action: string } | null {
  const r = db.prepare("SELECT * FROM undo_stack ORDER BY id DESC LIMIT 1").get() as
    | { id: number; action: string; label: string; ops: string }
    | undefined;
  if (!r) return null;
  let ops: UndoOp[] = [];
  try {
    ops = JSON.parse(r.ops);
  } catch {}
  for (const op of ops) applyOp(db, op);
  db.prepare("DELETE FROM undo_stack WHERE id=?").run(r.id);
  return { label: r.label, action: r.action };
}

/** The id the next decision_log INSERT will take (for building delDecisionLog ops). */
export function nextDecisionLogId(db: DatabaseSync): number {
  const r = db.prepare("SELECT COALESCE(MAX(id),0)+1 AS n FROM decision_log").get() as { n: number };
  return r.n;
}
