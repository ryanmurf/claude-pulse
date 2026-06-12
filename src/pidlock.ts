import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * Singleton pidfile lock for the agent daemon.
 *
 * Why: stacked daemon starts (manual nohup restarts on top of a systemd-managed
 * instance) once left FOUR agent daemons polling in parallel on one host,
 * quadrupling poll traffic and 429-throttling the usage API for every profile.
 * The daemon takes this lock at startup and refuses to start when another live
 * claude-pulse daemon already holds it.
 *
 * Semantics:
 *   - Lock file lives at $CLAUDE_PULSE_AGENT_PIDFILE, falling back to
 *     $XDG_CONFIG_HOME/claude-pulse/agent.pid, then ~/.config/claude-pulse/agent.pid.
 *   - Creation uses O_CREAT|O_EXCL (`wx`), so two racing starters can't both win.
 *   - A pidfile whose pid is dead, unparseable, or belongs to a non-claude-pulse
 *     process (pid reuse after a crash/SIGKILL) is STALE: it is removed and taken
 *     over.
 *   - A pidfile whose pid is alive but whose command line can't be inspected is
 *     conservatively treated as HELD — refusing to start is recoverable, a
 *     duplicate daemon is the incident we're preventing.
 */

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

/** Resolve the agent pidfile path (env override → XDG → ~/.config). */
export function defaultAgentPidFile(): string {
  const override = process.env.CLAUDE_PULSE_AGENT_PIDFILE;
  if (override) return override;
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "claude-pulse", "agent.pid");
}

/** Whether a pid refers to a live process (EPERM = alive but not ours). */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort command line for a pid; null when it can't be determined. */
function pidCommandLine(pid: number): string | null {
  // Linux: /proc/<pid>/cmdline is NUL-separated argv.
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (raw.length > 0) return raw.replace(/\0/g, " ").trim();
  } catch {
    /* not Linux, or no /proc access — fall through to ps */
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
    if (out.length > 0) return out;
  } catch {
    /* ps unavailable / pid gone */
  }
  return null;
}

/** Pure matcher: does a command line look like a node claude-pulse process? */
export function looksLikeClaudePulseCmdline(cmdline: string): boolean {
  return cmdline.includes("claude-pulse");
}

/**
 * Whether `pid` is a live node claude-pulse process. `null` cmdline (alive but
 * uninspectable) counts as claude-pulse — see the conservative-HELD note above.
 */
function isClaudePulseProcess(pid: number): boolean {
  const cmdline = pidCommandLine(pid);
  if (cmdline === null) return true;
  return looksLikeClaudePulseCmdline(cmdline);
}

export interface AcquireOptions {
  /** Pidfile path; defaults to defaultAgentPidFile(). */
  pidFile?: string;
  /** Own pid to record; defaults to process.pid. (test hook) */
  pid?: number;
  /** Liveness probe override. (test hook) */
  isAlive?: (pid: number) => boolean;
  /** Process-identity probe override. (test hook) */
  isClaudePulse?: (pid: number) => boolean;
}

export type AcquireResult =
  | { acquired: true; pidFile: string }
  | { acquired: false; pidFile: string; holderPid: number };

/**
 * Try to take the singleton agent lock. Returns `{acquired: false, holderPid}`
 * when another live claude-pulse daemon holds it; otherwise writes own pid
 * (taking over any stale file) and returns `{acquired: true}`.
 */
export function acquirePidLock(opts: AcquireOptions = {}): AcquireResult {
  const pidFile = opts.pidFile ?? defaultAgentPidFile();
  const ownPid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidIsAlive;
  const isPulse = opts.isClaudePulse ?? isClaudePulseProcess;

  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  // Two passes: exclusive create → on conflict, evaluate the holder → if stale,
  // remove + retry the exclusive create once. A second EEXIST means we lost a
  // race to another starter — report it as the holder.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(pidFile, `${ownPid}\n`, { flag: "wx" });
      return { acquired: true, pidFile };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    let holderPid = NaN;
    try {
      holderPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    } catch {
      /* unreadable/vanished — treat as stale */
    }

    const held =
      Number.isFinite(holderPid) &&
      holderPid > 0 &&
      holderPid !== ownPid &&
      isAlive(holderPid) &&
      isPulse(holderPid);
    if (held) {
      return { acquired: false, pidFile, holderPid };
    }

    // Stale (dead pid, garbage content, or pid reused by an unrelated process):
    // remove and retry the exclusive create.
    log(`Removing stale agent pidfile ${pidFile} (pid ${Number.isFinite(holderPid) ? holderPid : "?"})`);
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
  }

  // Lost the create race twice — someone else is starting up right now.
  let racerPid = NaN;
  try {
    racerPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  } catch {
    /* ignore */
  }
  return { acquired: false, pidFile, holderPid: Number.isFinite(racerPid) ? racerPid : -1 };
}

/**
 * Remove the pidfile on clean shutdown — but only when it still records OUR
 * pid, so a newer daemon that legitimately took over isn't sabotaged.
 */
export function releasePidLock(pidFile?: string, pid?: number): void {
  const file = pidFile ?? defaultAgentPidFile();
  const ownPid = pid ?? process.pid;
  try {
    const recorded = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    if (recorded === ownPid) fs.unlinkSync(file);
  } catch {
    /* no file / unreadable — nothing to release */
  }
}
