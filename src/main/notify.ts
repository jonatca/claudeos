/**
 * Desktop notifications with distinct sounds for "needs input" vs "done".
 * Sound is best-effort and degrades silently if no player is present.
 */
import { Notification } from "electron";
import { execFile } from "child_process";
import * as fs from "fs";

const FREEDESKTOP = "/usr/share/sounds/freedesktop/stereo";
const SOUNDS: Record<string, string[]> = {
  needs_input: [`${FREEDESKTOP}/message-new-instant.oga`, `${FREEDESKTOP}/dialog-information.oga`],
  done: [`${FREEDESKTOP}/complete.oga`, `${FREEDESKTOP}/service-login.oga`],
};

function playSound(kind: "needs_input" | "done"): void {
  const candidates = SOUNDS[kind] || [];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return;
  // paplay (PulseAudio) then aplay/ffplay fallbacks; ignore all errors.
  const players = ["paplay", "ffplay", "aplay"];
  const tryPlayer = (i: number) => {
    if (i >= players.length) return;
    const args = players[i] === "ffplay" ? ["-nodisp", "-autoexit", file] : [file];
    execFile(players[i], args, (err) => {
      if (err) tryPlayer(i + 1);
    });
  };
  tryPlayer(0);
}

export function notifyReady(kind: "needs_input" | "done", title: string, body: string): void {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: true /* we play our own distinct sound */ });
      n.show();
    }
  } catch {
    /* headless / no display */
  }
  playSound(kind);
}
