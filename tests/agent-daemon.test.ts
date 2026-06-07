import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  initDb,
  closeDb,
  resolveAccount,
  mintIngestToken,
  addProfile,
  removeProfile,
  listProfiles,
  getActiveContextSessions,
  getTokenUsage,
} from "../src/store.js";
import { startHttpServer, stopHttpServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
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

function waitFor(fn: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await fn()) return resolve();
      } catch {
        /* ignore */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 200);
    };
    tick();
  });
}

let tmpDir: string;
let centralPort: number;
let child: ChildProcess | undefined;
let centralDb: string;
let acctId: number;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-agent-test-"));

  // Central (in-process) receiver, using its OWN db.
  centralDb = path.join(tmpDir, "central.db");
  await initDb(centralDb);
  const acct = await resolveAccount("agent-user@example.com");
  acctId = acct.id;
  const { plaintext } = await mintIngestToken(acct.id, "agent-machine");
  centralPort = await getFreePort();
  startHttpServer(centralPort);

  // Seed the AGENT's own local db with a fixture-backed profile so context +
  // token rollups have something real to compute + push.
  const agentDb = path.join(tmpDir, "agent.db");
  const cfgDir = path.join(tmpDir, "agentcfg");
  const dest = path.join(cfgDir, "projects", "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "claude-usage.jsonl"), dest);
  // build the agent db with just our fixture profile
  await closeDb();
  await initDb(agentDb);
  for (const p of await listProfiles()) await removeProfile(p.name);
  await addProfile("fix", cfgDir, 5, "anthropic-oauth");
  await closeDb();

  // Re-open central for assertions.
  await initDb(centralDb);

  // Spawn the agent daemon as a child process pointed at the central server.
  child = spawn(process.execPath, [ENTRY, "--agent"], {
    env: {
      ...process.env,
      CLAUDE_PULSE_DB_PATH: agentDb,
      CLAUDE_PULSE_UPLOAD_TO: `http://127.0.0.1:${centralPort}`,
      CLAUDE_PULSE_INGEST_TOKEN: plaintext,
      // First-sync full-history backfill so the (old-dated) fixture token rows
      // are pushed even though they fall outside the incremental 2-day window.
      CLAUDE_PULSE_UPLOAD_BACKFILL: "1",
      // Fast cadences so the test completes quickly.
      CLAUDE_PULSE_PUSH_CONTEXT_INTERVAL: "500",
      CLAUDE_PULSE_PUSH_USAGE_INTERVAL: "100000",
      CLAUDE_PULSE_PUSH_TOKENS_INTERVAL: "500",
      CLAUDE_PULSE_PUSH_GEMINI_INTERVAL: "100000",
      PULSE_GEMINI_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", () => {
    /* drain so the pipe doesn't fill */
  });
});

afterEach(async () => {
  if (child) {
    child.kill("SIGKILL");
    child = undefined;
  }
  stopHttpServer();
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agent daemon (child process)", () => {
  it("pushes context sessions to the central server", async () => {
    await waitFor(async () => {
      const sessions = await getActiveContextSessions(acctId);
      return sessions.length > 0 && sessions.some((s) => s.profile === "fix");
    }, 40000);
    const sessions = await getActiveContextSessions(acctId);
    expect(sessions.some((s) => s.profile === "fix" && s.machine === "agent-machine")).toBe(true);
  }, 45000);

  it("pushes token rollups to the central server", async () => {
    await waitFor(async () => {
      const rows = await getTokenUsage({ accountId: acctId });
      return rows.length > 0;
    }, 40000);
    const rows = await getTokenUsage({ accountId: acctId });
    expect(rows.some((r) => r.profile === "fix" && r.source === "ingest")).toBe(true);
  }, 45000);
});
