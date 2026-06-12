import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb, closeDb, addProfile } from "../src/store.js";
import { _resetUploadBackoff } from "../src/upload.js";

// Stub only fetchUsage — keep the rest of the usage module real.
vi.mock("../src/usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/usage.js")>();
  return { ...actual, fetchUsage: vi.fn() };
});

import { agentPushSnapshots, agentPushGemini } from "../src/poller.js";
import { fetchUsage } from "../src/usage.js";

const mockFetchUsage = fetchUsage as ReturnType<typeof vi.fn>;

const INGEST_URL = "http://central.test/api/ingest";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

let tmpDir: string;
let ingestBodies: any[];

function stubFetch(extra?: (url: string, init?: RequestInit) => Response | null): void {
  ingestBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === INGEST_URL) {
        ingestBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const handled = extra?.(u, init);
      if (handled) return handled;
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-agentpush-test-"));
  await initDb(path.join(tmpDir, "test.db"));
  process.env.CLAUDE_PULSE_UPLOAD_TO = "http://central.test";
  process.env.CLAUDE_PULSE_INGEST_TOKEN = "cp_test_token";
  _resetUploadBackoff();
  mockFetchUsage.mockReset();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.CLAUDE_PULSE_UPLOAD_TO;
  delete process.env.CLAUDE_PULSE_INGEST_TOKEN;
  delete process.env.PULSE_GEMINI_OAUTH_PATH;
  delete process.env.PULSE_GEMINI_ENABLED;
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agentPushSnapshots", () => {
  it("polls the usage API exactly ONCE per profile per cycle and pushes that data", async () => {
    await addProfile("solo", path.join(tmpDir, "cfg"), 5);
    mockFetchUsage.mockResolvedValue({
      fiveHourPct: 41,
      fiveHourResetsAt: "2026-06-12T10:00:00.000Z",
      sevenDayPct: 62,
      sevenDayResetsAt: "2026-06-15T00:00:00.000Z",
      raw: "{}",
    });
    stubFetch();

    await agentPushSnapshots();

    // The double-poll regression: this used to be 2 (pollAllProfiles + computeUpload).
    expect(mockFetchUsage).toHaveBeenCalledTimes(1);

    const snapshots = ingestBodies.flatMap((b) => b.snapshots ?? []);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      profile: "solo",
      five_hour_pct: 41,
      five_hour_resets_at: "2026-06-12T10:00:00.000Z",
      seven_day_pct: 62,
      seven_day_resets_at: "2026-06-15T00:00:00.000Z",
    });
  });

  it("does not push null snapshots from failed polls", async () => {
    await addProfile("broken", path.join(tmpDir, "cfg2"), 5);
    mockFetchUsage.mockRejectedValue(new Error("No OAuth tokens found"));
    stubFetch();

    await agentPushSnapshots();

    const snapshots = ingestBodies.flatMap((b) => b.snapshots ?? []);
    expect(snapshots).toHaveLength(0);
  });
});

describe("agentPushGemini", () => {
  it("pushes the freshly polled gemini buckets (regression: throttled re-fetch pushed nothing)", async () => {
    // Valid (unexpired) gemini creds so no token refresh is needed.
    const credsPath = path.join(tmpDir, "oauth_creds.json");
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        access_token: "gem-token",
        refresh_token: "gem-refresh",
        expiry_date: Date.now() + 60 * 60 * 1000,
      }),
    );
    process.env.PULSE_GEMINI_OAUTH_PATH = credsPath;
    process.env.PULSE_GEMINI_ENABLED = "1";

    stubFetch((url) => {
      if (url === QUOTA_URL) {
        return new Response(
          JSON.stringify({
            buckets: [
              { modelId: "gemini-2.5-pro", remainingFraction: 0.25, remainingAmount: "25", resetTime: "2026-06-13T00:00:00Z" },
            ],
          }),
          { status: 200 },
        );
      }
      return null;
    });

    await agentPushGemini();

    const gemini = ingestBodies.flatMap((b) => b.gemini ?? []);
    expect(gemini).toHaveLength(1);
    expect(gemini[0]).toMatchObject({
      model_id: "gemini-2.5-pro",
      remaining_fraction: 0.25,
      remaining_amount: "25",
    });
  });
});
