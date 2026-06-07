import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb, closeDb } from "../src/store.js";
import { pollGeminiQuota } from "../src/gemini.js";

let tmpDir: string;
let oauthPath: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-gem-test-"));
  await initDb(path.join(tmpDir, "test.db"));

  // Expired access token + a refresh token → forces a refresh on poll.
  oauthPath = path.join(tmpDir, "oauth_creds.json");
  fs.writeFileSync(
    oauthPath,
    JSON.stringify({
      access_token: "stale",
      refresh_token: "refresh-abc",
      token_uri: "https://oauth2.googleapis.com/token",
      expiry: Date.now() - 60_000, // already expired
    }),
  );
  process.env.PULSE_GEMINI_OAUTH_PATH = oauthPath;
  process.env.PULSE_GEMINI_ENABLED = "1";
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.PULSE_GEMINI_OAUTH_PATH;
  delete process.env.PULSE_GEMINI_ENABLED;
  delete process.env.CLAUDE_PULSE_GEMINI_CLIENT_SECRET;
});

describe("gemini OAuth refresh", () => {
  it("includes client_secret in the refresh_token grant", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.fn(async (url: string, opts: RequestInit) => {
      calls.push({ url, body: String(opts.body) });
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
      }
      // quota call
      return new Response(JSON.stringify({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.5, remainingAmount: null, resetTime: null }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollGeminiQuota();
    expect(res.success).toBe(true);

    const refreshCall = calls.find((c) => c.url.includes("oauth2.googleapis.com/token"));
    expect(refreshCall).toBeDefined();
    const params = new URLSearchParams(refreshCall!.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-abc");
    // The fix: client_secret must be present (Google rejects the grant without it).
    expect(params.get("client_secret")).toBeTruthy();
    expect(params.get("client_id")).toBeTruthy();
  });

  it("honors CLAUDE_PULSE_GEMINI_CLIENT_SECRET override", async () => {
    process.env.CLAUDE_PULSE_GEMINI_CLIENT_SECRET = "OVERRIDE-SECRET";
    // Re-import is not needed: the module reads the env at call time only for the
    // constant default; the override is read at module load. To exercise the env
    // override deterministically we reset modules and re-import.
    vi.resetModules();
    const mod = await import("../src/gemini.js");

    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, opts: RequestInit) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        calls.push(String(opts.body));
        return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ buckets: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await mod.pollGeminiQuota();
    const params = new URLSearchParams(calls[0]);
    expect(params.get("client_secret")).toBe("OVERRIDE-SECRET");
  });
});
