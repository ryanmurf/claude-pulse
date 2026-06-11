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

    // Pin "now" inside both fixture windows so the staleness guard sees them as live.
    const usage = await fetchCodexRateLimits(tmpDir, new Date("2026-05-31T13:00:00Z"));

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

  // resets_at epochs: 5h = 2026-05-31T19:31:59Z (1780255919), 7d = 2026-06-07T02:46:05Z (1780800365)
  function writeRollout(resets5h = 1780255919, resets7d = 1780800365): string {
    const sessionsDir = path.join(tmpDir, "sessions", "2026", "05", "31");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const p = path.join(sessionsDir, "rollout-x.jsonl");
    fs.writeFileSync(
      p,
      JSON.stringify({
        msg: {
          rate_limits: {
            primary: { used_percent: 10, window_minutes: 300, resets_at: resets5h },
            secondary: { used_percent: 77, window_minutes: 10080, resets_at: resets7d },
          },
        },
      }) + "\n"
    );
    return p;
  }

  it("nulls an expired 5h window but keeps a still-live 7d window", async () => {
    writeRollout();
    // After the 5h reset, before the 7d reset.
    const usage = await fetchCodexRateLimits(tmpDir, new Date("2026-06-01T08:00:00Z"));
    expect(usage.fiveHourPct).toBeNull();
    expect(usage.fiveHourResetsAt).toBeNull();
    expect(usage.sevenDayPct).toBe(77);
    expect(usage.sevenDayResetsAt).toBe("2026-06-07T02:46:05.000Z");
  });

  it("throws when both windows are expired (idle machine has no current signal)", async () => {
    writeRollout();
    // Days after both resets — the exact tron failure mode of 2026-06-11.
    await expect(fetchCodexRateLimits(tmpDir, new Date("2026-06-11T22:00:00Z"))).rejects.toThrow(
      /fully expired/,
    );
  });
});
