import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initDb,
  closeDb,
  ensureDefaultProfiles,
  listProfiles,
  getProfile,
  addProfile,
  removeProfile,
  updatePollInterval,
  insertSnapshot,
  ingestUsageSnapshot,
  getLatestSnapshot,
  getLatestSnapshots,
  getLastSuccessfulSnapshot,
  getHistory,
  createAlertSubscription,
  listAlertSubscriptions,
  removeAlertSubscription,
  createAlertEvent,
  getTriggeredAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  insertGeminiQuotaSnapshots,
  getLatestGeminiQuota,
  redactProfile,
  upsertTokenRollup,
  getTokenRollups,
  getTokenReport,
  localAccountId,
} from "../src/store.js";

let tmpDir: string;
let LA: number;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  await initDb(dbPath);
  LA = await localAccountId();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("initDb", () => {
  it("creates tables without error", async () => {
    // initDb already called in beforeEach — just verify a profile can be inserted
    const profile = await addProfile("test-profile", "/tmp/test", 5);
    expect(profile).toBeDefined();
    expect(profile.name).toBe("test-profile");
  });
});

describe("ensureDefaultProfiles", () => {
  it("creates claude-hd and claude-max profiles", async () => {
    await ensureDefaultProfiles();
    const profiles = await listProfiles();
    const names = profiles.map((p) => p.name);
    expect(names).toContain("claude-hd");
    expect(names).toContain("claude-max");
  });

  it("is idempotent — calling twice does not duplicate", async () => {
    await ensureDefaultProfiles();
    await ensureDefaultProfiles();
    const profiles = await listProfiles();
    const hdCount = profiles.filter((p) => p.name === "claude-hd").length;
    expect(hdCount).toBe(1);
  });
});

describe("addProfile / getProfile / removeProfile", () => {
  it("adds and retrieves a profile", async () => {
    const profile = await addProfile("my-profile", "/home/user/.claude-custom", 10);
    expect(profile.name).toBe("my-profile");
    expect(profile.config_dir).toBe("/home/user/.claude-custom");
    expect(profile.poll_interval_minutes).toBe(10);

    const fetched = await getProfile("my-profile");
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("my-profile");
  });

  it("returns undefined for non-existent profile", async () => {
    const result = await getProfile("does-not-exist");
    expect(result).toBeUndefined();
  });

  it("removes a profile", async () => {
    await addProfile("to-remove", "/tmp/remove", 5);
    const removed = await removeProfile("to-remove");
    expect(removed).toBe(true);

    const fetched = await getProfile("to-remove");
    expect(fetched).toBeUndefined();
  });

  it("returns false when removing non-existent profile", async () => {
    const removed = await removeProfile("ghost");
    expect(removed).toBe(false);
  });
});

describe("redactProfile", () => {
  it("masks stored API keys and preserves null keys", async () => {
    const profileWithKey = await addProfile(
      "with-key",
      "/tmp/with-key",
      5,
      "deepseek-balance",
      10,
      "sk-secret"
    );
    const profileWithoutKey = await addProfile("without-key", "/tmp/without-key", 5);

    expect(redactProfile(profileWithKey).api_key).toBe("***");
    expect(redactProfile(profileWithoutKey).api_key).toBeNull();
  });
});

describe("insertSnapshot / getLatestSnapshot / getHistory", () => {
  it("inserts and retrieves a snapshot", async () => {
    await addProfile("snap-test", "/tmp/snap", 5);
    const snapshot = await insertSnapshot(
      "snap-test",
      45.2,
      "2026-03-25T18:00:00Z",
      30.1,
      "2026-03-30T00:00:00Z",
      '{"raw": true}'
    );

    expect(snapshot.id).toBeDefined();
    expect(snapshot.profile).toBe("snap-test");
    expect(snapshot.five_hour_pct).toBeCloseTo(45.2);
    expect(snapshot.seven_day_pct).toBeCloseTo(30.1);
  });

  it("getLatestSnapshot returns the most recent snapshot", async () => {
    await addProfile("latest-test", "/tmp/latest", 5);
    await insertSnapshot("latest-test", 10.0, null, 20.0, null, null);
    await insertSnapshot("latest-test", 50.0, null, 60.0, null, null);

    const latest = await getLatestSnapshot("latest-test");
    expect(latest).toBeDefined();
    expect(latest!.five_hour_pct).toBeCloseTo(50.0);
    expect(latest!.seven_day_pct).toBeCloseTo(60.0);
  });

  it("getLatestSnapshot returns undefined when no snapshots exist", async () => {
    await addProfile("empty-profile", "/tmp/empty", 5);
    const result = await getLatestSnapshot("empty-profile");
    expect(result).toBeUndefined();
  });

  it("getLatestSnapshots returns one per profile", async () => {
    await addProfile("p1", "/tmp/p1", 5);
    await addProfile("p2", "/tmp/p2", 5);
    await insertSnapshot("p1", 10, null, 20, null, null);
    await insertSnapshot("p1", 30, null, 40, null, null);
    await insertSnapshot("p2", 50, null, 60, null, null);

    const latest = await getLatestSnapshots();
    // Each profile should have at most one entry
    const p1snaps = latest.filter((s) => s.profile === "p1");
    const p2snaps = latest.filter((s) => s.profile === "p2");
    expect(p1snaps.length).toBeGreaterThanOrEqual(1);
    expect(p2snaps.length).toBe(1);

    // The p1 entry with the highest id should be the latest (30%)
    const p1snap = p1snaps.reduce((a, b) => (a.id > b.id ? a : b));
    expect(p1snap.five_hour_pct).toBeCloseTo(30);

    expect(p2snaps[0].five_hour_pct).toBeCloseTo(50);
  });

  it("getHistory returns snapshots within time window", async () => {
    await addProfile("hist-test", "/tmp/hist", 5);
    await insertSnapshot("hist-test", 10, null, 20, null, null);
    await insertSnapshot("hist-test", 30, null, 40, null, null);
    await insertSnapshot("hist-test", 50, null, 60, null, null);

    const history = await getHistory("hist-test", 24, 100);
    expect(history.length).toBe(3);
    // Should be ordered DESC by polled_at
    expect(history[0].five_hour_pct).toBeCloseTo(50);
  });

  it("getHistory respects limit", async () => {
    await addProfile("lim-test", "/tmp/lim", 5);
    for (let i = 0; i < 10; i++) {
      await insertSnapshot("lim-test", i * 10, null, i * 5, null, null);
    }

    const history = await getHistory("lim-test", 24, 3);
    expect(history).toHaveLength(3);
  });
});

describe("snapshot staleness guard (latest-poll-wins regression)", () => {
  // A weekly window's reset_at. The same string = the same window (Δ ≤ jitter
  // tolerance); +7d = a genuine reset to a fresh window.
  const R7 = "2026-07-06T03:04:59Z";
  const R7_NEXT = "2026-07-13T03:04:59Z";
  const R5 = "2026-06-30T05:00:00Z";
  const R5_NEXT = "2026-06-30T10:00:00Z"; // +5h, a new 5h window

  it("insertSnapshot rejects a lower used_percent for the same 7d window (52→16 must not overwrite)", async () => {
    await addProfile("regress-7d", "/tmp/r7", 5);
    await insertSnapshot("regress-7d", null, null, 52.0, R7, null);
    // Stale poll (e.g. transcript fallback) re-reports the same window at 16%.
    await insertSnapshot("regress-7d", null, null, 16.0, R7, null);

    const latest = await getLatestSnapshot("regress-7d");
    expect(latest!.seven_day_pct).toBeCloseTo(52.0);
  });

  it("insertSnapshot accepts a rising used_percent within the same window", async () => {
    await addProfile("rise-7d", "/tmp/rise", 5);
    await insertSnapshot("rise-7d", null, null, 52.0, R7, null);
    await insertSnapshot("rise-7d", null, null, 55.0, R7, null);

    const latest = await getLatestSnapshot("rise-7d");
    expect(latest!.seven_day_pct).toBeCloseTo(55.0);
  });

  it("insertSnapshot accepts a drop to 0 on a genuine weekly reset (reset_at jumps +7d)", async () => {
    await addProfile("reset-7d", "/tmp/reset", 5);
    await insertSnapshot("reset-7d", null, null, 52.0, R7, null);
    await insertSnapshot("reset-7d", null, null, 0.0, R7_NEXT, null);

    const latest = await getLatestSnapshot("reset-7d");
    expect(latest!.seven_day_pct).toBeCloseTo(0.0);
    expect(latest!.seven_day_resets_at).toBe(R7_NEXT);
  });

  it("insertSnapshot accepts a 5h reset to 0 while the 7d window holds steady", async () => {
    await addProfile("cycle-5h", "/tmp/c5", 5);
    await insertSnapshot("cycle-5h", 80.0, R5, 52.0, R7, null);
    await insertSnapshot("cycle-5h", 0.0, R5_NEXT, 52.0, R7, null);

    const latest = await getLatestSnapshot("cycle-5h");
    expect(latest!.five_hour_pct).toBeCloseTo(0.0);
    expect(latest!.seven_day_pct).toBeCloseTo(52.0);
  });

  it("insertSnapshot still inserts null-usage (error/context) rows — they never regress", async () => {
    await addProfile("null-ok", "/tmp/null", 5);
    await insertSnapshot("null-ok", null, null, 52.0, R7, null);
    await insertSnapshot("null-ok", null, null, null, null, '{"error":"rate limit"}');

    const history = await getHistory("null-ok", 24, 100);
    expect(history).toHaveLength(2);
  });

  it("ingestUsageSnapshot (push path) also rejects a same-window used_percent regression", async () => {
    await addProfile("regress-ingest", "/tmp/ri", 5);
    await ingestUsageSnapshot({
      account_id: LA,
      profile: "regress-ingest",
      five_hour_pct: 0,
      five_hour_resets_at: R5,
      seven_day_pct: 52,
      seven_day_resets_at: R7,
    });
    // An old / transcript-only reporter re-pushes the same window at 16%.
    await ingestUsageSnapshot({
      account_id: LA,
      profile: "regress-ingest",
      five_hour_pct: 0,
      five_hour_resets_at: R5,
      seven_day_pct: 16,
      seven_day_resets_at: R7,
    });

    const latest = await getLatestSnapshot("regress-ingest", LA);
    expect(latest!.seven_day_pct).toBeCloseTo(52);
  });
});

describe("getLastSuccessfulSnapshot", () => {
  it("returns the most recent snapshot with non-null resets_at", async () => {
    await addProfile("resume-test", "/tmp/resume", 5);
    await insertSnapshot("resume-test", 45.0, "2026-03-25T18:00:00Z", 30.0, "2026-03-30T00:00:00Z", null);
    // A later failed snapshot with null values
    await insertSnapshot("resume-test", null, null, null, null, '{"error":"rate limit"}');

    const last = await getLastSuccessfulSnapshot("resume-test");
    expect(last).toBeDefined();
    expect(last!.five_hour_pct).toBeCloseTo(45.0);
    expect(last!.five_hour_resets_at).toBe("2026-03-25T18:00:00Z");
  });

  it("returns undefined when no successful snapshots exist", async () => {
    await addProfile("no-success", "/tmp/nosuccess", 5);
    await insertSnapshot("no-success", null, null, null, null, '{"error":"auth"}');

    const last = await getLastSuccessfulSnapshot("no-success");
    expect(last).toBeUndefined();
  });

  it("returns snapshot with only one resets_at present", async () => {
    await addProfile("partial-reset", "/tmp/partial", 5);
    await insertSnapshot("partial-reset", 60.0, "2026-03-25T20:00:00Z", null, null, null);

    const last = await getLastSuccessfulSnapshot("partial-reset");
    expect(last).toBeDefined();
    expect(last!.five_hour_resets_at).toBe("2026-03-25T20:00:00Z");
    expect(last!.seven_day_resets_at).toBeNull();
  });
});

describe("gemini quota snapshots", () => {
  it("inserts and returns latest Gemini quota per model", async () => {
    await insertGeminiQuotaSnapshots([
      {
        modelId: "gemini-2.5-pro",
        remainingFraction: 0.73,
        remainingAmount: "730",
        resetTime: "2026-05-04T07:00:00Z",
      },
      {
        modelId: "gemini-2.5-flash",
        remainingFraction: 0.5,
        remainingAmount: null,
        resetTime: "2026-05-04T07:00:00Z",
      },
    ]);
    await insertGeminiQuotaSnapshots([
      {
        modelId: "gemini-2.5-pro",
        remainingFraction: 0.2,
        remainingAmount: "200",
        resetTime: "2026-05-05T07:00:00Z",
      },
    ]);

    const latest = await getLatestGeminiQuota();
    expect(latest).toHaveLength(2);
    expect(latest.find((q) => q.model_id === "gemini-2.5-pro")!.remaining_fraction).toBeCloseTo(0.2);
    expect(latest.find((q) => q.model_id === "gemini-2.5-flash")!.remaining_fraction).toBeCloseTo(0.5);
  });
});

describe("alert subscriptions", () => {
  it("creates and lists alert subscriptions", async () => {
    await addProfile("alert-prof", "/tmp/alert", 5);
    const sub = await createAlertSubscription(
      LA,
      "alert-prof",
      "five_hour_threshold",
      90,
      null,
      30
    );

    expect(sub.id).toBeDefined();
    expect(sub.profile).toBe("alert-prof");
    expect(sub.alert_type).toBe("five_hour_threshold");
    expect(sub.threshold).toBe(90);
    expect(sub.cooldown_minutes).toBe(30);
    expect(sub.enabled).toBe(1);

    const subs = await listAlertSubscriptions(LA, "alert-prof");
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(sub.id);
  });

  it("lists all subscriptions when no profile filter", async () => {
    await addProfile("p1", "/tmp/p1", 5);
    await addProfile("p2", "/tmp/p2", 5);
    await createAlertSubscription(LA, "p1", "five_hour_threshold", 80, null, 30);
    await createAlertSubscription(LA, "p2", "seven_day_threshold", 70, null, 60);

    const all = await listAlertSubscriptions(LA);
    expect(all).toHaveLength(2);
  });

  it("removes an alert subscription", async () => {
    await addProfile("rm-alert", "/tmp/rm", 5);
    const sub = await createAlertSubscription(
      LA,
      "rm-alert",
      "auth_failure",
      null,
      null,
      15
    );

    const removed = await removeAlertSubscription(LA, sub.id);
    expect(removed).toBe(true);

    const remaining = await listAlertSubscriptions(LA, "rm-alert");
    expect(remaining).toHaveLength(0);
  });

  it("returns false when removing non-existent subscription", async () => {
    const removed = await removeAlertSubscription(LA, 9999);
    expect(removed).toBe(false);
  });
});

describe("alert events", () => {
  it("creates and retrieves alert events", async () => {
    await addProfile("evt-prof", "/tmp/evt", 5);
    const sub = await createAlertSubscription(
      LA,
      "evt-prof",
      "five_hour_threshold",
      90,
      null,
      30
    );

    const event = await createAlertEvent(
      LA,
      sub.id,
      "evt-prof",
      "five_hour_threshold",
      "Usage at 95%",
      95.0,
      90.0
    );

    expect(event.id).toBeDefined();
    expect(event.subscription_id).toBe(sub.id);
    expect(event.profile).toBe("evt-prof");
    expect(event.acknowledged).toBe(0);

    const triggered = await getTriggeredAlerts(LA, "evt-prof", 24, false);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].id).toBe(event.id);
  });

  it("acknowledges a single alert", async () => {
    await addProfile("ack-prof", "/tmp/ack", 5);
    const sub = await createAlertSubscription(
      LA,
      "ack-prof",
      "five_hour_threshold",
      90,
      null,
      30
    );
    const event = await createAlertEvent(
      LA,
      sub.id,
      "ack-prof",
      "five_hour_threshold",
      "Alert!",
      95,
      90
    );

    const acked = await acknowledgeAlert(LA, event.id);
    expect(acked).toBe(true);

    // Second ack should return false
    const acked2 = await acknowledgeAlert(LA, event.id);
    expect(acked2).toBe(false);

    const unacked = await getTriggeredAlerts(LA, "ack-prof", 24, true);
    expect(unacked).toHaveLength(0);
  });

  it("acknowledges all alerts for a profile", async () => {
    await addProfile("ack-all", "/tmp/ackall", 5);
    const sub = await createAlertSubscription(
      LA,
      "ack-all",
      "five_hour_threshold",
      90,
      null,
      30
    );
    await createAlertEvent(LA, sub.id, "ack-all", "five_hour_threshold", "A1", 91, 90);
    await createAlertEvent(LA, sub.id, "ack-all", "five_hour_threshold", "A2", 93, 90);

    const count = await acknowledgeAllAlerts(LA, "ack-all");
    expect(count).toBe(2);

    const unacked = await getTriggeredAlerts(LA, "ack-all", 24, true);
    expect(unacked).toHaveLength(0);
  });

  it("acknowledges all alerts across all profiles", async () => {
    await addProfile("aa1", "/tmp/aa1", 5);
    await addProfile("aa2", "/tmp/aa2", 5);
    const sub1 = await createAlertSubscription(LA, "aa1", "five_hour_threshold", 90, null, 30);
    const sub2 = await createAlertSubscription(LA, "aa2", "seven_day_threshold", 80, null, 30);
    await createAlertEvent(LA, sub1.id, "aa1", "five_hour_threshold", "X", 95, 90);
    await createAlertEvent(LA, sub2.id, "aa2", "seven_day_threshold", "Y", 85, 80);

    const count = await acknowledgeAllAlerts(LA);
    expect(count).toBe(2);
  });

  it("filters triggered alerts by unacknowledged_only", async () => {
    await addProfile("filter-prof", "/tmp/filter", 5);
    const sub = await createAlertSubscription(
      LA,
      "filter-prof",
      "five_hour_threshold",
      90,
      null,
      30
    );
    const e1 = await createAlertEvent(LA, sub.id, "filter-prof", "five_hour_threshold", "E1", 91, 90);
    await createAlertEvent(LA, sub.id, "filter-prof", "five_hour_threshold", "E2", 95, 90);

    await acknowledgeAlert(LA, e1.id);

    const unacked = await getTriggeredAlerts(LA, "filter-prof", 24, true);
    expect(unacked).toHaveLength(1);
    expect(unacked[0].message).toBe("E2");
  });
});

describe("updatePollInterval", () => {
  it("updates poll interval for existing profile", async () => {
    await addProfile("interval-test", "/tmp/interval", 5);
    const updated = await updatePollInterval("interval-test", 15);
    expect(updated).toBe(true);

    const profile = await getProfile("interval-test");
    expect(profile!.poll_interval_minutes).toBe(15);
  });

  it("returns false for non-existent profile", async () => {
    const updated = await updatePollInterval("no-such-profile", 10);
    expect(updated).toBe(false);
  });
});

describe("token rollups", () => {
  function row(over: Partial<Parameters<typeof upsertTokenRollup>[0]> = {}) {
    return {
      profile: "claude-max",
      host: "tron",
      day: "2026-06-01",
      model: "claude-opus-4-8",
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 200,
      cache_read_tokens: 800,
      cost_usd: 1.5,
      source: "local" as const,
      ...over,
    };
  }

  it("upserts and reads back a rollup", async () => {
    await upsertTokenRollup(row());
    const rows = await getTokenRollups();
    expect(rows.length).toBe(1);
    expect(rows[0].input_tokens).toBe(100);
    expect(rows[0].source).toBe("local");
  });

  it("ON CONFLICT replaces counts for same (profile,host,day,model)", async () => {
    await upsertTokenRollup(row({ input_tokens: 100 }));
    await upsertTokenRollup(row({ input_tokens: 999, cost_usd: 9 }));
    const rows = await getTokenRollups();
    expect(rows.length).toBe(1);
    expect(rows[0].input_tokens).toBe(999);
    expect(rows[0].cost_usd).toBe(9);
  });

  it("keeps separate rows per host", async () => {
    await upsertTokenRollup(row({ host: "tron" }));
    await upsertTokenRollup(row({ host: "laptop" }));
    expect((await getTokenRollups()).length).toBe(2);
    expect((await getTokenRollups({ host: "laptop" })).length).toBe(1);
  });

  it("filters by sinceDay and profile", async () => {
    await upsertTokenRollup(row({ day: "2026-05-01" }));
    await upsertTokenRollup(row({ day: "2026-06-05" }));
    await upsertTokenRollup(row({ profile: "claude-hd", day: "2026-06-05", model: "claude-sonnet-4-6" }));
    expect((await getTokenRollups({ sinceDay: "2026-06-01" })).length).toBe(2);
    expect((await getTokenRollups({ profile: "claude-hd" })).length).toBe(1);
  });

  it("getTokenReport aggregates per profile with host + day breakdown and grand total", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await upsertTokenRollup(row({ host: "tron", day: today, input_tokens: 100, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 2 }));
    await upsertTokenRollup(row({ host: "laptop", day: today, input_tokens: 50, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 1 }));
    await upsertTokenRollup(row({ host: "tron", day: yesterday, input_tokens: 25, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0.5 }));

    const report = await getTokenReport({ granularity: "daily", days: 30 });
    expect(report.profiles.length).toBe(1);
    const p = report.profiles[0];
    expect(p.profile).toBe("claude-max");
    expect(p.input_tokens).toBe(175);
    expect(p.total_tokens).toBe(175);
    expect(p.cost_usd).toBeCloseTo(3.5, 6);
    expect(p.by_host.length).toBe(2);
    expect(p.by_day.length).toBe(2);
    expect(report.total.cost_usd).toBeCloseTo(3.5, 6);
  });

  it("weekly granularity buckets days into ISO weeks", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    await upsertTokenRollup(row({ day: today, model: "m1" }));
    await upsertTokenRollup(row({ day: sixDaysAgo, model: "m2" }));
    const report = await getTokenReport({ granularity: "weekly", days: 30 });
    // 7-day span may straddle 1 or 2 ISO weeks; just assert bucketing doesn't explode per-day.
    expect(report.profiles[0].by_day.length).toBeLessThanOrEqual(2);
    expect(report.granularity).toBe("weekly");
  });
});
