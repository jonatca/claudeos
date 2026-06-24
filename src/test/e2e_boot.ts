/**
 * Shared E2E boot helper: starts the REAL ClaudeOS web server as a subprocess in a fully
 * isolated DEMO sandbox, waits until it is serving a seeded queue, and hands back the base
 * URL + a clean stop().
 *
 * Isolation guarantees (so a test run NEVER touches the operator's production data):
 *   - COCKPIT_DEMO=1      → throwaway data/demo.db (wiped on boot), no real tmux/gh/claude,
 *                           no auto-discovery, no real PR scan, no real board scan. Merges run
 *                           in a throwaway /tmp repo; the real-GH merge path is a guarded no-op.
 *   - COCKPIT_CONFIG_DIR  → a fresh temp dir (copied weights/keymap) so learning + the nightly
 *                           "dream" + RANKING.md only ever write to throwaway config, never the
 *                           operator's real config/weights.json.
 *   - COCKPIT_PORT        → an OS-assigned free port (no clash with a running cockpit).
 */
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";

export interface DemoServer {
  port: number;
  base: string;
  proc: ChildProcess;
  configDir: string;
  vizDir: string; // temp viz_dir the server scans — tests drop <slug>/*.html here to give a session a visualization
  log: () => string;
  stop: () => Promise<void>;
}

const REPO_ROOT = path.resolve(__dirname, "../..");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a free TCP port (bind :0, read it back, release). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll `fn` until it returns true or `ms` elapses. */
export async function waitFor(fn: () => Promise<boolean>, ms: number, everyMs = 200): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(everyMs);
  }
  return false;
}

export async function startDemoServer(): Promise<DemoServer> {
  const port = await freePort();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-e2e-cfg-"));
  for (const f of ["weights.json", "keymap.json"]) {
    const srcF = path.join(REPO_ROOT, "config", f);
    if (fs.existsSync(srcF)) fs.copyFileSync(srcF, path.join(configDir, f));
  }
  // Point viz_dir at a temp dir so tests can create REAL per-task visualizations at runtime
  // (standard-layout auto-html regression guards) instead of scanning the operator's NFS dir.
  const vizDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-e2e-viz-"));
  try {
    const wPath = path.join(configDir, "weights.json");
    const w = JSON.parse(fs.readFileSync(wPath, "utf8"));
    w.viz_dir = vizDir;
    fs.writeFileSync(wPath, JSON.stringify(w, null, 2));
  } catch {}
  const env = {
    ...process.env,
    COCKPIT_DEMO: "1",
    COCKPIT_PORT: String(port),
    COCKPIT_HOST: "127.0.0.1",
    COCKPIT_CONFIG_DIR: configDir,
    COCKPIT_SSH_HOST: "localhost",
  };
  const proc = spawn("node", [path.join(REPO_ROOT, "dist/server/server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout!.on("data", (d) => (buf += d.toString()));
  proc.stderr!.on("data", (d) => (buf += d.toString()));

  const base = `http://127.0.0.1:${port}`;
  const ready = await waitFor(async () => {
    const r = await fetch(base + "/api/state");
    if (!r.ok) return false;
    const j: any = await r.json();
    return Array.isArray(j.queue) && j.queue.length > 0; // seeded
  }, 25000);

  const stop = async (): Promise<void> => {
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(vizDir, { recursive: true, force: true });
    } catch {}
    if (proc.exitCode !== null || proc.signalCode) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      proc.on("exit", fin);
      try {
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        fin();
      }, 2500);
    });
  };

  if (!ready) {
    await stop();
    throw new Error("demo server never became ready on " + base + "\n--- server log ---\n" + buf);
  }
  return { port, base, proc, configDir, vizDir, log: () => buf, stop };
}
