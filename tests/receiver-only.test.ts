import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

/** Spawn dist/index.js with the given env, collect stderr until `marker` appears. */
function runUntil(
  env: Record<string, string>,
  marker: string,
  timeoutMs = 35000,
): Promise<{ child: ChildProcess; logs: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let logs = "";
    const timer = setTimeout(() => {
      reject(new Error(`marker not seen in ${timeoutMs}ms; logs:\n${logs}`));
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr?.on("data", (d) => {
      logs += String(d);
      if (logs.includes(marker)) {
        clearTimeout(timer);
        resolve({ child, logs });
      }
    });
    child.on("error", reject);
  });
}

let tmpDir: string;
let port: number;
let child: ChildProcess | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-recv-test-"));
  port = await getFreePort();
});

afterEach(() => {
  if (child) {
    child.kill("SIGKILL");
    child = undefined;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("receiver-only mode", () => {
  it("starts the HTTP server + ingest but NO local pollers", async () => {
    const dbPath = path.join(tmpDir, "recv.db");
    const r = await runUntil(
      {
        CLAUDE_PULSE_SERVER_ONLY: "1",
        CLAUDE_PULSE_RECEIVER_ONLY: "1",
        CLAUDE_PULSE_DB_PATH: dbPath,
        CLAUDE_PULSE_PORT: String(port),
        PULSE_GEMINI_ENABLED: "0",
      },
      "Dashboard available at",
    );
    child = r.child;

    // Give the process a beat to have logged any poller-start lines (it won't).
    await new Promise((res) => setTimeout(res, 800));

    // Pull whatever else was logged.
    let extra = "";
    child.stderr?.on("data", (d) => (extra += String(d)));
    await new Promise((res) => setTimeout(res, 200));
    const logs = r.logs + extra;

    expect(logs).toContain("Receiver-only mode: skipping all local pollers");
    // None of the poller start lines should appear.
    expect(logs).not.toContain("Token rollup loop started");
    expect(logs).not.toContain("Context poller started");
    expect(logs).not.toContain("Started pollers for");
    expect(logs).not.toContain("Started Gemini quota poller");

    // The HTTP server is up and serving the API.
    const resp = await fetch(`http://127.0.0.1:${port}/api/me`);
    expect(resp.status).toBe(200);
  }, 40000);

  it("server-only (without receiver-only) DOES start pollers", async () => {
    const dbPath = path.join(tmpDir, "srv.db");
    const r = await runUntil(
      {
        CLAUDE_PULSE_SERVER_ONLY: "1",
        CLAUDE_PULSE_DB_PATH: dbPath,
        CLAUDE_PULSE_PORT: String(port),
        PULSE_GEMINI_ENABLED: "0",
      },
      "Started pollers for",
    );
    child = r.child;
    expect(r.logs).toContain("Started pollers for");
    expect(r.logs).not.toContain("Receiver-only mode");
  }, 40000);
});
