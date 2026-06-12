import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquirePidLock,
  releasePidLock,
  pidIsAlive,
  looksLikeClaudePulseCmdline,
} from "../src/pidlock.js";

let tmpDir: string;
let pidFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-pidlock-test-"));
  pidFile = path.join(tmpDir, "agent.pid");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A real pid that is guaranteed dead: spawn a no-op node and let it exit. */
function deadPid(): number {
  const res = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(res.pid).toBeGreaterThan(0);
  return res.pid!;
}

describe("acquirePidLock", () => {
  it("acquires when no pidfile exists and records own pid", () => {
    const result = acquirePidLock({ pidFile });
    expect(result.acquired).toBe(true);
    expect(parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)).toBe(process.pid);
  });

  it("creates missing parent directories", () => {
    const nested = path.join(tmpDir, "deep", "er", "agent.pid");
    const result = acquirePidLock({ pidFile: nested });
    expect(result.acquired).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("refuses when the recorded pid is alive and is a claude-pulse process", () => {
    // Use our own (definitely alive) pid as the holder, with identity forced true.
    const holder = process.pid + 0;
    fs.writeFileSync(pidFile, `${holder}\n`);
    const result = acquirePidLock({
      pidFile,
      pid: 999_999_999, // pretend we're a different process
      isClaudePulse: () => true,
    });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.holderPid).toBe(holder);
    // The holder's pidfile is left untouched.
    expect(parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)).toBe(holder);
  });

  it("takes over a stale pidfile whose pid is dead", () => {
    fs.writeFileSync(pidFile, `${deadPid()}\n`);
    const result = acquirePidLock({ pidFile });
    expect(result.acquired).toBe(true);
    expect(parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)).toBe(process.pid);
  });

  it("takes over when the pid is alive but is NOT a claude-pulse process (pid reuse)", () => {
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    const result = acquirePidLock({
      pidFile,
      pid: 999_999_999,
      isClaudePulse: () => false, // reused pid belongs to something else
    });
    expect(result.acquired).toBe(true);
    expect(parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)).toBe(999_999_999);
  });

  it("takes over a pidfile with garbage content", () => {
    fs.writeFileSync(pidFile, "not-a-pid\n");
    const result = acquirePidLock({ pidFile });
    expect(result.acquired).toBe(true);
    expect(parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10)).toBe(process.pid);
  });
});

describe("releasePidLock", () => {
  it("removes the pidfile when it records our pid", () => {
    acquirePidLock({ pidFile });
    releasePidLock(pidFile);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("leaves the pidfile alone when another pid took over", () => {
    fs.writeFileSync(pidFile, `${process.pid + 1}\n`);
    releasePidLock(pidFile);
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("is a no-op when the pidfile does not exist", () => {
    expect(() => releasePidLock(pidFile)).not.toThrow();
  });
});

describe("pid helpers", () => {
  it("pidIsAlive: own process is alive, freshly-dead process is not", () => {
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(pidIsAlive(deadPid())).toBe(false);
  });

  it("looksLikeClaudePulseCmdline matches daemon command lines only", () => {
    expect(looksLikeClaudePulseCmdline("node /opt/claude-pulse/dist/index.js --agent")).toBe(true);
    expect(looksLikeClaudePulseCmdline("/usr/local/bin/claude-pulse --agent")).toBe(true);
    expect(looksLikeClaudePulseCmdline("node /srv/some-other-app/server.js")).toBe(false);
    expect(looksLikeClaudePulseCmdline("nginx: worker process")).toBe(false);
  });
});
