import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb, closeDb, addProfile } from "../src/store.js";

// Mock the usage module — this replaces the HTTP calls to Anthropic's API
vi.mock("../src/usage.js", async (importOriginal) => {
  // Keep the real vendorPollsRateLimitSnapshot (anthropic-oauth → true,
  // antigravity → false) so the skip path is exercised with real logic; only
  // fetchUsage is stubbed.
  const actual = await importOriginal<typeof import("../src/usage.js")>();
  return { ...actual, fetchUsage: vi.fn() };
});

import { pollProfile, isRateLimitError, scheduleWindowResume, cancelPendingResumes } from "../src/poller.js";
import { fetchUsage } from "../src/usage.js";
import type { UsageData } from "../src/usage.js";

const mockFetchUsage = fetchUsage as ReturnType<typeof vi.fn>;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-poller-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  await initDb(dbPath);
  await addProfile("test-profile", "/tmp/test-config", 5);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockUsageSuccess(data: UsageData): void {
  mockFetchUsage.mockResolvedValue(data);
}

function mockUsageError(message: string): void {
  mockFetchUsage.mockRejectedValue(new Error(message));
}

describe("pollProfile", () => {
  it("parses usage data from API response", async () => {
    mockUsageSuccess({
      fiveHourPct: 45.2,
      fiveHourResetsAt: "2026-03-25T18:00:00Z",
      sevenDayPct: 30.1,
      sevenDayResetsAt: "2026-03-30T00:00:00Z",
      raw: '{"five_hour":{"utilization":45.2,"resets_at":"2026-03-25T18:00:00Z"},"seven_day":{"utilization":30.1,"resets_at":"2026-03-30T00:00:00Z"}}',
    });

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(true);
    expect(result.profile).toBe("test-profile");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.five_hour_pct).toBeCloseTo(45.2);
    expect(result.snapshot!.five_hour_resets_at).toBe("2026-03-25T18:00:00Z");
    expect(result.snapshot!.seven_day_pct).toBeCloseTo(30.1);
    expect(result.snapshot!.seven_day_resets_at).toBe("2026-03-30T00:00:00Z");
  });

  it("handles null usage values", async () => {
    mockUsageSuccess({
      fiveHourPct: null,
      fiveHourResetsAt: null,
      sevenDayPct: null,
      sevenDayResetsAt: null,
      raw: "{}",
    });

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.five_hour_pct).toBeNull();
    expect(result.snapshot!.seven_day_pct).toBeNull();
  });

  it("handles fetch errors", async () => {
    mockUsageError("No OAuth tokens found for /tmp/test-config");

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No OAuth tokens");
    // Should still record a null snapshot
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.five_hour_pct).toBeNull();
    expect(result.snapshot!.seven_day_pct).toBeNull();
  });

  it("returns error for non-existent profile", async () => {
    const result = await pollProfile("no-such-profile");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Profile not found");
  });

  it("handles partial usage data (only five_hour)", async () => {
    mockUsageSuccess({
      fiveHourPct: 60.0,
      fiveHourResetsAt: "2026-03-25T20:00:00Z",
      sevenDayPct: null,
      sevenDayResetsAt: null,
      raw: '{"five_hour":{"utilization":60.0,"resets_at":"2026-03-25T20:00:00Z"}}',
    });

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(true);
    expect(result.snapshot!.five_hour_pct).toBeCloseTo(60.0);
    expect(result.snapshot!.seven_day_pct).toBeNull();
  });

  it("calls fetchUsage with the profile", async () => {
    mockUsageSuccess({
      fiveHourPct: 25.0,
      fiveHourResetsAt: "2026-03-25T15:00:00Z",
      sevenDayPct: 10.0,
      sevenDayResetsAt: "2026-03-28T00:00:00Z",
      raw: "{}",
    });

    await pollProfile("test-profile");

    expect(mockFetchUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test-profile",
        config_dir: "/tmp/test-config",
        vendor: "anthropic-oauth",
      })
    );
  });

  it("skips the snapshot poll for token-tally-only vendors (antigravity)", async () => {
    await addProfile("agy", "/tmp/agy-config", 5, "antigravity");
    mockFetchUsage.mockClear();

    const result = await pollProfile("agy");

    // Quietly skipped: success, no snapshot, and fetchUsage never called.
    expect(result.success).toBe(true);
    expect(result.profile).toBe("agy");
    expect(result.snapshot).toBeUndefined();
    expect(mockFetchUsage).not.toHaveBeenCalled();
  });
});

describe("isRateLimitError", () => {
  it("detects real rate-limit signals", async () => {
    expect(isRateLimitError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("Rate Limit reached"))).toBe(true);
    expect(isRateLimitError(new Error("too many requests"))).toBe(true);
    expect(isRateLimitError(new Error("usage limit hit"))).toBe(true);
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("Usage API returned 429: throttled"))).toBe(true);
    expect(isRateLimitError(new Error('{"type":"error","error":{"type":"rate_limit_error"}}'))).toBe(true);
  });

  it("returns false for non-rate-limit errors", async () => {
    expect(isRateLimitError(new Error("No OAuth tokens found"))).toBe(false);
    expect(isRateLimitError(new Error("ENOENT"))).toBe(false);
    expect(isRateLimitError(new Error("authentication failed"))).toBe(false);
  });

  it("does NOT match the codex staleness error (the idle-machine false positive)", async () => {
    // The exact production noise source: every poll on an idle-codex machine
    // threw this, and the old substring match on "rate_limits" mis-classified
    // it as a rate limit, logging bogus "Rate-limit detected / cannot schedule
    // resume" lines each cycle.
    expect(
      isRateLimitError(
        new Error(
          "codex usage windows in /home/u/.codex/sessions/rollout-x.jsonl are fully expired (codex idle here since they were recorded); no current usage signal",
        ),
      ),
    ).toBe(false);
    // Even the OLD wording must not match — "rate_limits" is not a rate-limit signal.
    expect(
      isRateLimitError(
        new Error(
          "codex rate_limits in /home/u/.codex/sessions/rollout-x.jsonl are fully expired; no current usage signal",
        ),
      ),
    ).toBe(false);
    expect(isRateLimitError(new Error("No codex rate_limits found under /home/u/.codex/sessions"))).toBe(false);
  });

  it("does NOT match arbitrary substrings like 429 inside ids or paths", async () => {
    expect(isRateLimitError(new Error("failed to read /tmp/session-4429x.jsonl"))).toBe(false);
    expect(isRateLimitError(new Error("snapshot id 14290 missing"))).toBe(false);
    expect(isRateLimitError(new Error("resource_exhausted"))).toBe(false);
    expect(isRateLimitError(new Error("overloaded"))).toBe(false);
    expect(isRateLimitError(new Error("over capacity"))).toBe(false);
    expect(isRateLimitError(new Error("quota exceeded for model"))).toBe(false);
  });
});

describe("auto-resume scheduling", () => {
  afterEach(async () => {
    cancelPendingResumes();
  });

  it("schedules resume on rate-limit poll failure with last successful snapshot", async () => {
    // First: successful poll to establish resets_at in DB
    const futureReset = new Date(Date.now() + 3_600_000).toISOString(); // +1 hour
    mockUsageSuccess({
      fiveHourPct: 95.0,
      fiveHourResetsAt: futureReset,
      sevenDayPct: 40.0,
      sevenDayResetsAt: "2026-03-30T00:00:00Z",
      raw: "{}",
    });
    const successResult = await pollProfile("test-profile");
    expect(successResult.success).toBe(true);

    // Now: rate-limit failure
    mockUsageError("rate limit exceeded");
    const failResult = await pollProfile("test-profile");
    expect(failResult.success).toBe(false);
    expect(failResult.error).toContain("rate limit");
  });

  it("does not schedule resume for non-rate-limit errors", async () => {
    mockUsageError("No OAuth tokens found for /tmp/test-config");
    const result = await pollProfile("test-profile");
    expect(result.success).toBe(false);
    expect(result.error).toContain("No OAuth tokens");
  });

  it("deduplicates resume scheduling for same profile + resetsAt", async () => {
    const futureReset = new Date(Date.now() + 3_600_000).toISOString();
    // Calling twice should not throw or create duplicate timers
    scheduleWindowResume("test-profile", futureReset);
    scheduleWindowResume("test-profile", futureReset);
    // If we get here without error, dedup works
  });

  it("cancelPendingResumes clears timers for a specific profile", async () => {
    const futureReset = new Date(Date.now() + 3_600_000).toISOString();
    scheduleWindowResume("profile-a", futureReset);
    scheduleWindowResume("profile-b", futureReset);

    cancelPendingResumes("profile-a");
    // profile-b timer should still be active — cleanup in afterEach
  });
});
