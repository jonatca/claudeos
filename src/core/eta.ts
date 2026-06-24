/**
 * ETA tracking for long-running, silent sessions.
 *
 * The "X ago" timestamp (transcript mtime) tells you when a session last WROTE, but a
 * session running a long background job is silent the whole time — "40m ago" is ambiguous
 * between "idle/parked" and "a script has been chugging for 40m". This module resolves that
 * for REACHABLE (parked-at-the-prompt) sessions: the engine sends a `/eta` probe and the
 * session replies with a single terse line, which we parse here.
 *
 * Convention (see ~/.claude/commands/eta.md):
 *   eta: 50m        → ~50 minutes of work left
 *   eta: 1h30m      → an hour and a half
 *   eta: done       → finished (let normal DONE detection surface it)
 *   eta: none       → nothing running right now (idle)
 *
 * We NEVER probe an actively-WORKING session — keystrokes would just queue behind its
 * running foreground tool and never be seen. Probing is for parked sessions where Claude
 * has returned to the prompt and can introspect its own background jobs.
 */

import { claudeJson } from "./claude";

/** The literal text the engine injects to probe a session. `/eta` is a Claude Code slash
 *  command (global, ~/.claude/commands/eta.md) that constrains the reply to one terse line. */
export const ETA_PROBE_TEXT = "/eta";

export interface EtaParse {
  kind: "time" | "done" | "none";
  minutes?: number; // present when kind === 'time'
  raw: string; // the verbatim value after `eta:`
}

/** Parse a duration like "50m", "2h", "1h30m", "90", "1.5h", "2d" into whole minutes.
 *  A bare number is treated as minutes. Returns null if nothing parseable. */
export function parseDurationMinutes(s: string): number | null {
  const t = (s || "").trim().toLowerCase();
  if (!t) return null;
  // Bare number => minutes.
  if (/^\d+(\.\d+)?$/.test(t)) return Math.max(0, Math.round(parseFloat(t)));
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(h(?:rs?|ours?)?|m(?:in(?:ute)?s?)?|d(?:ays?)?|s(?:ec(?:ond)?s?)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    matched = true;
    const n = parseFloat(m[1]);
    const u = m[2];
    if (u.startsWith("h")) total += n * 60;
    else if (u.startsWith("d")) total += n * 60 * 24;
    else if (u.startsWith("s")) total += n / 60;
    else total += n; // minutes
  }
  return matched ? Math.max(0, Math.round(total)) : null;
}

/** Extract the freshest `eta:` marker from a block of text (e.g. the last assistant turn).
 *  Returns null if there is no marker at all. */
export function parseEtaMarker(text: string): EtaParse | null {
  if (!text) return null;
  let hit: string | null = null;
  for (const ln of text.split(/\r?\n/)) {
    const m = ln.match(/^\s*eta:\s*(.+?)\s*$/i);
    if (m) hit = m[1]; // keep the LAST one — most recent in the turn
  }
  if (hit == null) return null;
  const v = hit.trim().toLowerCase();
  if (/^(done|finished|complete[d]?|over|0)$/.test(v)) return { kind: "done", raw: hit };
  if (/^(none|n\/?a|nothing|idle|unknown|\?+)$/.test(v)) return { kind: "none", raw: hit };
  const mins = parseDurationMinutes(v);
  if (mins == null) return null;
  return { kind: "time", minutes: mins, raw: hit };
}

/** Pure mapping from Haiku's JSON verdict to an EtaParse. Exported so the (model-dependent)
 *  interpretation can be unit-tested without a live call. Mirrors parseEtaMarker's shape. */
export function etaFromJson(j: { kind?: string; minutes?: number } | null): EtaParse | null {
  if (!j) return null;
  const kind = String(j.kind || "").toLowerCase();
  if (kind === "done") return { kind: "done", raw: "done" };
  if (kind === "none") return { kind: "none", raw: "none" };
  if (kind === "time" && typeof j.minutes === "number" && isFinite(j.minutes)) {
    const m = Math.max(0, Math.round(j.minutes));
    return { kind: "time", minutes: m, raw: `${m}m` };
  }
  return null;
}

/** HAIKU INTERPRETATION (the "read the reply and distill the ETA" step): when a probed session
 *  answers in its OWN words instead of the terse `eta:` line (e.g. "the eval has ~3 epochs left,
 *  roughly 90 minutes"), the cheap parser can't read it. Hand the reply to Haiku and let it extract
 *  the remaining time. Returns null on any failure so the caller degrades gracefully (keeps trying
 *  on the expiry loop). Kept lean (no MCP/CLAUDE.md) like every other cockpit `claude -p` call. */
export async function interpretEta(reply: string, model: string): Promise<EtaParse | null> {
  const t = (reply || "").trim();
  if (!t) return null;
  const j = await claudeJson<{ kind?: string; minutes?: number }>(
    `A long-running coding session was asked "how long until your CURRENT task finishes?" and replied below. ` +
      `Read the reply and extract the remaining time as the operator would understand it.\n` +
      `Output JSON {"kind":"time|done|none","minutes":<integer minutes, ONLY when kind=time>}.\n` +
      `- kind="done" if the work has finished.\n` +
      `- kind="none" if nothing is running / it is idle / it genuinely cannot say.\n` +
      `- otherwise kind="time" with your best single integer-minute estimate of the time LEFT.\n\n` +
      `Reply: """${t.slice(-2000)}"""`,
    { model, timeoutMs: 30000, label: "eta" }
  );
  return etaFromJson(j);
}

/** PASSIVE ETA (no injection): read a long-running session's OWN recent output — its live terminal
 *  screen or transcript tail, NOT a reply to any question we asked — and let Haiku estimate the time
 *  LEFT from whatever progress is visible (progress bars, epoch/step counts, "N/M done", elapsed-vs-
 *  total, the last command). We never type into the session; this only observes. Returns null on
 *  failure / when there's no evidence of a running task. */
export async function estimateEtaFromOutput(output: string, model: string): Promise<EtaParse | null> {
  const t = (output || "").trim();
  if (!t) return null;
  const j = await claudeJson<{ kind?: string; minutes?: number }>(
    `Below is the recent terminal output / transcript tail of a long-running coding or training session. ` +
      `Estimate how long until its CURRENT task finishes, judging ONLY from what is shown. Look for ` +
      `progress bars, epoch/step/interval counts (e.g. "3/10"), elapsed-vs-total times, ETAs the tool ` +
      `printed, or the last long command. Do NOT invent progress that isn't visible.\n` +
      `Output JSON {"kind":"time|done|none","minutes":<integer minutes, ONLY when kind=time>}.\n` +
      `- kind="time": your best single integer-minute estimate of the time LEFT.\n` +
      `- kind="done": the visible task has finished.\n` +
      `- kind="none": nothing is running / it is idle / you genuinely cannot tell.\n\n` +
      `Output:\n"""${t.slice(-3000)}"""`,
    { model, timeoutMs: 30000, label: "eta" }
  );
  return etaFromJson(j);
}

/** Compact "time left until eta_at" for the card/roster, e.g. "~50m", "~2h10m", "due now". */
export function formatTimeLeft(etaAtIso: string | null | undefined, now = Date.now()): string {
  if (!etaAtIso) return "";
  const at = Date.parse(etaAtIso.includes("T") ? etaAtIso : etaAtIso.replace(" ", "T") + "Z");
  if (isNaN(at)) return "";
  const mins = Math.round((at - now) / 60000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `~${mins}m`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return r ? `~${h}h${r}m` : `~${h}h`;
}
