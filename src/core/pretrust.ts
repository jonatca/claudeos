/**
 * Pre-trust a worktree directory so a freshly-launched Claude Code session does not
 * stall on the interactive "Do you trust this folder?" dialog. This writes exactly
 * what pressing "Yes, I trust this folder" would: projects[path].hasTrustDialogAccepted=true
 * in ~/.claude.json. It only ADDS missing entries and never modifies existing ones,
 * and writes atomically. The operator implicitly authorizes this by launching a session
 * the cockpit created.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function pretrust(worktreePath: string): boolean {
  const cfgPath = path.join(os.homedir(), ".claude.json");
  try {
    if (!fs.existsSync(cfgPath)) return false;
    const raw = fs.readFileSync(cfgPath, "utf8");
    const j = JSON.parse(raw);
    j.projects = j.projects || {};
    const existing = j.projects[worktreePath];
    if (existing && existing.hasTrustDialogAccepted) return true; // already trusted, untouched
    j.projects[worktreePath] = {
      ...(existing || {}),
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: Math.max(1, existing?.projectOnboardingSeenCount || 0),
      hasCompletedProjectOnboarding: true,
    };
    const tmp = cfgPath + ".cockpit.tmp";
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
    fs.renameSync(tmp, cfgPath);
    return true;
  } catch {
    return false;
  }
}
