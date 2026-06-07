import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, closeDb, addProfile, removeProfile, listProfiles } from "../src/store.js";
import { runTokenRollupOnce } from "../src/poller.js";
import { _resetUploadBackoff } from "../src/upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let tmpDir: string;
let cfgDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-cont-test-"));
  initDb(path.join(tmpDir, "test.db"));

  // A profile whose transcripts produce real token rows.
  cfgDir = path.join(tmpDir, "cfg");
  const dest = path.join(cfgDir, "projects", "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "claude-usage.jsonl"), dest);

  // Replace the default profiles with our single fixture-backed one.
  for (const p of listProfiles()) removeProfile(p.name);
  addProfile("fix", cfgDir, 5, "anthropic-oauth");

  _resetUploadBackoff();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetUploadBackoff();
  delete process.env.CLAUDE_PULSE_UPLOAD_TO;
  delete process.env.CLAUDE_PULSE_INGEST_TOKEN;
});

describe("continuous reporting from the rollup loop", () => {
  it("pushes to central when upload env is set", async () => {
    process.env.CLAUDE_PULSE_UPLOAD_TO = "https://central.example";
    process.env.CLAUDE_PULSE_INGEST_TOKEN = "tok-xyz";
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Full-history lookback so the (old-dated) fixture rows are included.
    await runTokenRollupOnce(10_000);

    expect(fetchMock).toHaveBeenCalled();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://central.example/api/ingest");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok-xyz");
    const body = JSON.parse(opts.body as string);
    expect(body.rollups.length).toBeGreaterThan(0);
  });

  it("does NOT push when upload env is unset", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runTokenRollupOnce(10_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
