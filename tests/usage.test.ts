import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchCodexRateLimits } from "../src/usage.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-usage-test-"));
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("fetchCodexRateLimits", () => {
  it("uses the last nested rate_limits object from a recent rollout file", async () => {
    const sessionsDir = path.join(tmpDir, "sessions", "2026", "05", "31");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const stalePath = path.join(sessionsDir, "rollout-stale.jsonl");
    fs.writeFileSync(
      stalePath,
      JSON.stringify({
        payload: {
          rate_limits: {
            primary: { used_percent: 88, window_minutes: 300, resets_at: 1780250000 },
            secondary: { used_percent: 66, window_minutes: 10080, resets_at: 1780800000 },
          },
        },
      }) + "\n"
    );

    const newestPath = path.join(sessionsDir, "rollout-newest.jsonl");
    fs.writeFileSync(newestPath, JSON.stringify({ payload: { msg: "no limits here" } }) + "\n");

    const currentPath = path.join(sessionsDir, "rollout-current.jsonl");
    fs.writeFileSync(
      currentPath,
      [
        JSON.stringify({
          payload: {
            info: {
              rate_limits: {
                primary: { used_percent: 90, window_minutes: 300, resets_at: 1780251000 },
              },
            },
          },
        }),
        JSON.stringify({
          msg: {
            rate_limits: {
              primary: { used_percent: 0, window_minutes: 300, resets_at: 1780255919 },
              secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1780800365 },
            },
          },
        }),
      ].join("\n") + "\n"
    );

    const base = new Date("2026-05-31T12:00:00Z");
    fs.utimesSync(stalePath, base, base);
    fs.utimesSync(currentPath, new Date(base.getTime() + 1_000), new Date(base.getTime() + 1_000));
    fs.utimesSync(newestPath, new Date(base.getTime() + 2_000), new Date(base.getTime() + 2_000));

    const usage = await fetchCodexRateLimits(tmpDir);

    expect(usage.fiveHourPct).toBe(0);
    expect(usage.fiveHourResetsAt).toBe("2026-05-31T19:31:59.000Z");
    expect(usage.sevenDayPct).toBe(3);
    expect(usage.sevenDayResetsAt).toBe("2026-06-07T02:46:05.000Z");
    expect(JSON.parse(usage.raw)).toMatchObject({
      vendor: "openai-codex",
      source: currentPath,
      rate_limits: {
        primary: { used_percent: 0 },
        secondary: { used_percent: 3 },
      },
    });
  });
});
