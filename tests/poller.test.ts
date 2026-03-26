import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { initDb, closeDb, addProfile } from "../src/store.js";

// The real `execFile` has a `[util.promisify.custom]` symbol that makes
// `promisify(execFile)` return `{ stdout, stderr }` instead of just `stdout`.
// We need our mock to replicate that behavior.
vi.mock("node:child_process", () => {
  const impl = vi.fn();

  // Attach the custom promisify symbol so promisify(execFile) works like the real thing
  (impl as any)[promisify.custom] = vi.fn();

  return { execFile: impl };
});

import { pollProfile } from "../src/poller.js";
import { execFile } from "node:child_process";

// Get the custom promisify function that poller.ts will actually call
const mockExecFileAsync = (execFile as any)[promisify.custom] as ReturnType<typeof vi.fn>;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-poller-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  initDb(dbPath);
  addProfile("test-profile", "/tmp/test-config", 5);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockExecFileSuccess(stdout: string): void {
  mockExecFileAsync.mockResolvedValue({ stdout, stderr: "" });
}

function mockExecFileError(errorMessage: string): void {
  mockExecFileAsync.mockRejectedValue(new Error(errorMessage));
}

describe("pollProfile", () => {
  it("parses rate_limits from claude CLI output", async () => {
    const cliOutput = JSON.stringify({
      result: "ok",
      rate_limits: {
        five_hour: {
          used_percentage: 45.2,
          resets_at: "2026-03-25T18:00:00Z",
        },
        seven_day: {
          used_percentage: 30.1,
          resets_at: "2026-03-30T00:00:00Z",
        },
      },
    });

    mockExecFileSuccess(cliOutput);

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(true);
    expect(result.profile).toBe("test-profile");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.five_hour_pct).toBeCloseTo(45.2);
    expect(result.snapshot!.five_hour_resets_at).toBe("2026-03-25T18:00:00Z");
    expect(result.snapshot!.seven_day_pct).toBeCloseTo(30.1);
    expect(result.snapshot!.seven_day_resets_at).toBe("2026-03-30T00:00:00Z");
  });

  it("handles missing rate_limits gracefully", async () => {
    const cliOutput = JSON.stringify({
      result: "ok",
    });

    mockExecFileSuccess(cliOutput);

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.five_hour_pct).toBeNull();
    expect(result.snapshot!.seven_day_pct).toBeNull();
  });

  it("handles CLI errors", async () => {
    mockExecFileError("Command failed: claude not found");

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Command failed");
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

  it("handles partial rate_limits (only five_hour)", async () => {
    const cliOutput = JSON.stringify({
      result: "ok",
      rate_limits: {
        five_hour: {
          used_percentage: 60.0,
          resets_at: "2026-03-25T20:00:00Z",
        },
      },
    });

    mockExecFileSuccess(cliOutput);

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(true);
    expect(result.snapshot!.five_hour_pct).toBeCloseTo(60.0);
    expect(result.snapshot!.seven_day_pct).toBeNull();
  });

  it("handles JSON with extra text around it", async () => {
    const cliOutput = `Some log text\n${JSON.stringify({
      result: "ok",
      rate_limits: {
        five_hour: { used_percentage: 25.0, resets_at: "2026-03-25T15:00:00Z" },
        seven_day: { used_percentage: 10.0, resets_at: "2026-03-28T00:00:00Z" },
      },
    })}\ntrailing text`;

    mockExecFileSuccess(cliOutput);

    const result = await pollProfile("test-profile");

    expect(result.success).toBe(true);
    expect(result.snapshot!.five_hour_pct).toBeCloseTo(25.0);
    expect(result.snapshot!.seven_day_pct).toBeCloseTo(10.0);
  });
});
