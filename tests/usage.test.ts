import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fetchCodexRateLimits,
  fetchCodexUsageApi,
  fetchCodexUsage,
  fetchViaUsageApi,
  truncateIsoToSeconds,
} from "../src/usage.js";
import type { OAuthTokens } from "../src/auth.js";

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

  it("prefers the freshest rate_limits ENTRY even when it lives in an older-mtime file", async () => {
    // Reproduces the real bug: a long-lived session's rollout file keeps getting
    // appended (so its mtime is newest) long after its last API call, leaving a
    // STALE rate_limits reading — while a different file with an OLDER mtime holds
    // a FRESHER reading from a more recent API call. Ranking by file mtime picks
    // the stale 16%; ranking by the entry's own timestamp picks the live 52%.
    const sessionsDir = path.join(tmpDir, "sessions", "2026", "05", "31");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // resets_at: 5h = 1780255919 (2026-05-31T19:31:59Z), 7d = 1780800365 (2026-06-07T02:46:05Z)
    const line = (ts: string, fivePct: number, sevenPct: number) =>
      JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: {
          rate_limits: {
            primary: { used_percent: fivePct, window_minutes: 300, resets_at: 1780255919 },
            secondary: { used_percent: sevenPct, window_minutes: 10080, resets_at: 1780800365 },
          },
        },
      }) + "\n";

    // Touched-late file: last API line is OLD (12:00) but the file kept being
    // appended, so it has the NEWEST mtime.
    const stalePath = path.join(sessionsDir, "rollout-touched-late.jsonl");
    fs.writeFileSync(stalePath, line("2026-05-31T12:00:00.000Z", 10, 16));

    // Fresh file: last API line is RECENT (18:00) but its mtime is older.
    const freshPath = path.join(sessionsDir, "rollout-fresh.jsonl");
    fs.writeFileSync(freshPath, line("2026-05-31T18:00:00.000Z", 40, 52));

    const t = (iso: string) => new Date(iso);
    fs.utimesSync(freshPath, t("2026-05-31T18:05:00Z"), t("2026-05-31T18:05:00Z"));
    fs.utimesSync(stalePath, t("2026-05-31T20:00:00Z"), t("2026-05-31T20:00:00Z")); // newest mtime

    // Pin "now" so both windows are still live.
    const usage = await fetchCodexRateLimits(tmpDir, new Date("2026-05-31T19:00:00Z"));

    expect(usage.sevenDayPct).toBe(52); // the fresher entry, NOT the stale 16
    expect(usage.fiveHourPct).toBe(40);
    expect(JSON.parse(usage.raw).source).toBe(freshPath);
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

  it("staleness error does not contain rate-limit trigger substrings", async () => {
    writeRollout();
    let message = "";
    try {
      await fetchCodexRateLimits(tmpDir, new Date("2026-06-11T22:00:00Z"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/fully expired/);
    // Must never re-trip the poller's isRateLimitError matcher.
    expect(message.toLowerCase()).not.toContain("rate_limit");
    expect(message).not.toMatch(/\b429\b/);
  });
});

// ── fetchViaUsageApi: retry + resets_at normalization (mocked fetch) ─────────

const TOKENS: OAuthTokens = {
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["user:profile"],
  subscriptionType: "max",
  rateLimitTier: "default",
};

function okUsageResponse(fiveResetsAt: string, sevenResetsAt: string): Response {
  return new Response(
    JSON.stringify({
      five_hour: { utilization: 12.5, resets_at: fiveResetsAt },
      seven_day: { utilization: 42.0, resets_at: sevenResetsAt },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("fetchViaUsageApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("truncates sub-second resets_at noise to whole seconds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okUsageResponse("2026-06-12T04:40:00.714116Z", "2026-06-15T11:00:00.123Z"),
      ),
    );

    const usage = await fetchViaUsageApi(TOKENS, { retryDelaysMs: [] });
    expect(usage.fiveHourResetsAt).toBe("2026-06-12T04:40:00.000Z");
    expect(usage.sevenDayResetsAt).toBe("2026-06-15T11:00:00.000Z");
    expect(usage.fiveHourPct).toBe(12.5);
    expect(usage.sevenDayPct).toBe(42.0);
  });

  it("retries a 429 then succeeds within the same poll", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response("throttled", { status: 429 }))
      .mockResolvedValueOnce(
        okUsageResponse("2026-06-12T04:40:00Z", "2026-06-15T11:00:00Z"),
      );
    vi.stubGlobal("fetch", mock);

    const usage = await fetchViaUsageApi(TOKENS, { retryDelaysMs: [1, 1] });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(usage.fiveHourPct).toBe(12.5);
  });

  it("retries a 500 then succeeds within the same poll", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(
        okUsageResponse("2026-06-12T04:40:00Z", "2026-06-15T11:00:00Z"),
      );
    vi.stubGlobal("fetch", mock);

    const usage = await fetchViaUsageApi(TOKENS, { retryDelaysMs: [1, 1] });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(usage.sevenDayPct).toBe(42.0);
  });

  it("throws after exhausting retries on persistent 429", async () => {
    const mock = vi.fn().mockImplementation(
      async () => new Response("still throttled", { status: 429 }),
    );
    vi.stubGlobal("fetch", mock);

    await expect(fetchViaUsageApi(TOKENS, { retryDelaysMs: [1, 1] })).rejects.toThrow(
      /Usage API returned 429/,
    );
    // 1 initial + 2 retries
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry non-retryable statuses (401)", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", mock);

    await expect(fetchViaUsageApi(TOKENS, { retryDelaysMs: [1, 1] })).rejects.toThrow(
      /Usage API returned 401/,
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("truncateIsoToSeconds", () => {
  it("truncates fractional seconds and normalizes to ISO", () => {
    expect(truncateIsoToSeconds("2026-06-12T04:40:00.714116Z")).toBe("2026-06-12T04:40:00.000Z");
    expect(truncateIsoToSeconds("2026-06-12T04:40:00Z")).toBe("2026-06-12T04:40:00.000Z");
    expect(truncateIsoToSeconds(null)).toBeNull();
    // Unparseable input passes through untouched rather than becoming Invalid Date.
    expect(truncateIsoToSeconds("not-a-date")).toBe("not-a-date");
  });
});

// ── Codex live usage API (/wham/usage) ──────────────────────────────────────

function writeCodexAuth(dir: string, tokens: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "at-123", account_id: "acc-456", refresh_token: "rt", ...tokens } }),
  );
}
function whamResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
// 5h reset 1782683430 = 2026-06-28T21:50:30Z ; 7d reset 1783270230 = 2026-07-05T16:50:30Z
const WHAM_OK = {
  user_id: "u-1",
  account_id: "acc-456",
  email: "secret@example.com",
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 15, limit_window_seconds: 18000, reset_at: 1782683430 },
    secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 1783270230 },
  },
};

describe("fetchCodexUsageApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps primary_window→5h and secondary_window→7d from reset_at", async () => {
    writeCodexAuth(tmpDir);
    const fetchMock = vi.fn().mockResolvedValue(whamResponse(WHAM_OK));
    vi.stubGlobal("fetch", fetchMock);

    const u = await fetchCodexUsageApi(tmpDir);

    expect(u.fiveHourPct).toBe(15);
    expect(u.sevenDayPct).toBe(2);
    expect(u.fiveHourResetsAt).toBe("2026-06-28T21:50:30.000Z");
    expect(u.sevenDayResetsAt).toBe("2026-07-05T16:50:30.000Z");
    // Correct endpoint + auth headers.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(init.headers.Authorization).toBe("Bearer at-123");
    expect(init.headers["ChatGPT-Account-ID"]).toBe("acc-456");
    // raw must NOT leak identity fields.
    expect(u.raw).not.toContain("secret@example.com");
    expect(u.raw).not.toContain("u-1");
    expect(JSON.parse(u.raw)).toMatchObject({ source: "api:/wham/usage", plan_type: "pro" });
  });

  it("throws on non-2xx so the caller can fall back", async () => {
    writeCodexAuth(tmpDir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(whamResponse("nope", 401)));
    await expect(fetchCodexUsageApi(tmpDir)).rejects.toThrow(/returned 401/);
  });

  it("throws (no fetch) when auth.json is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCodexUsageApi(tmpDir)).rejects.toThrow(/auth\.json/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchCodexUsage (API-first, transcript fallback)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the live API when it succeeds", async () => {
    writeCodexAuth(tmpDir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(whamResponse(WHAM_OK)));
    const u = await fetchCodexUsage(tmpDir);
    expect(u.sevenDayPct).toBe(2);
    expect(JSON.parse(u.raw).source).toBe("api:/wham/usage");
  });

  it("falls back to rollout transcripts when the API fails", async () => {
    writeCodexAuth(tmpDir);
    const sessionsDir = path.join(tmpDir, "sessions", "2026", "05", "31");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "rollout-x.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-31T12:00:00.000Z",
        payload: {
          rate_limits: {
            primary: { used_percent: 10, window_minutes: 300, resets_at: 1780255919 },
            secondary: { used_percent: 77, window_minutes: 10080, resets_at: 1780800365 },
          },
        },
      }) + "\n",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(whamResponse("boom", 500)));

    const u = await fetchCodexUsage(tmpDir, new Date("2026-06-01T08:00:00Z")); // after 5h reset, before 7d
    expect(u.sevenDayPct).toBe(77); // from the transcript
    expect(JSON.parse(u.raw).source).toContain("rollout-x.jsonl");
  });

  it("falls back to transcripts when auth.json is absent", async () => {
    const sessionsDir = path.join(tmpDir, "sessions", "2026", "05", "31");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "rollout-y.jsonl"),
      JSON.stringify({
        msg: { rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 1780255919 }, secondary: { used_percent: 33, window_minutes: 10080, resets_at: 1780800365 } } },
      }) + "\n",
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const u = await fetchCodexUsage(tmpDir, new Date("2026-06-01T08:00:00Z"));
    expect(u.sevenDayPct).toBe(33);
    expect(fetchMock).not.toHaveBeenCalled(); // missing auth.json short-circuits before any GET
  });
});
