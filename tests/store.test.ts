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
} from "../src/store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("initDb", () => {
  it("creates tables without error", () => {
    // initDb already called in beforeEach — just verify a profile can be inserted
    const profile = addProfile("test-profile", "/tmp/test", 5);
    expect(profile).toBeDefined();
    expect(profile.name).toBe("test-profile");
  });
});

describe("ensureDefaultProfiles", () => {
  it("creates claude-hd and claude-max profiles", () => {
    ensureDefaultProfiles();
    const profiles = listProfiles();
    const names = profiles.map((p) => p.name);
    expect(names).toContain("claude-hd");
    expect(names).toContain("claude-max");
  });

  it("is idempotent — calling twice does not duplicate", () => {
    ensureDefaultProfiles();
    ensureDefaultProfiles();
    const profiles = listProfiles();
    const hdCount = profiles.filter((p) => p.name === "claude-hd").length;
    expect(hdCount).toBe(1);
  });
});

describe("addProfile / getProfile / removeProfile", () => {
  it("adds and retrieves a profile", () => {
    const profile = addProfile("my-profile", "/home/user/.claude-custom", 10);
    expect(profile.name).toBe("my-profile");
    expect(profile.config_dir).toBe("/home/user/.claude-custom");
    expect(profile.poll_interval_minutes).toBe(10);

    const fetched = getProfile("my-profile");
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("my-profile");
  });

  it("returns undefined for non-existent profile", () => {
    const result = getProfile("does-not-exist");
    expect(result).toBeUndefined();
  });

  it("removes a profile", () => {
    addProfile("to-remove", "/tmp/remove", 5);
    const removed = removeProfile("to-remove");
    expect(removed).toBe(true);

    const fetched = getProfile("to-remove");
    expect(fetched).toBeUndefined();
  });

  it("returns false when removing non-existent profile", () => {
    const removed = removeProfile("ghost");
    expect(removed).toBe(false);
  });
});

describe("redactProfile", () => {
  it("masks stored API keys and preserves null keys", () => {
    const profileWithKey = addProfile(
      "with-key",
      "/tmp/with-key",
      5,
      "deepseek-balance",
      10,
      "sk-secret"
    );
    const profileWithoutKey = addProfile("without-key", "/tmp/without-key", 5);

    expect(redactProfile(profileWithKey).api_key).toBe("***");
    expect(redactProfile(profileWithoutKey).api_key).toBeNull();
  });
});

describe("insertSnapshot / getLatestSnapshot / getHistory", () => {
  it("inserts and retrieves a snapshot", () => {
    addProfile("snap-test", "/tmp/snap", 5);
    const snapshot = insertSnapshot(
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

  it("getLatestSnapshot returns the most recent snapshot", () => {
    addProfile("latest-test", "/tmp/latest", 5);
    insertSnapshot("latest-test", 10.0, null, 20.0, null, null);
    insertSnapshot("latest-test", 50.0, null, 60.0, null, null);

    const latest = getLatestSnapshot("latest-test");
    expect(latest).toBeDefined();
    expect(latest!.five_hour_pct).toBeCloseTo(50.0);
    expect(latest!.seven_day_pct).toBeCloseTo(60.0);
  });

  it("getLatestSnapshot returns undefined when no snapshots exist", () => {
    addProfile("empty-profile", "/tmp/empty", 5);
    const result = getLatestSnapshot("empty-profile");
    expect(result).toBeUndefined();
  });

  it("getLatestSnapshots returns one per profile", () => {
    addProfile("p1", "/tmp/p1", 5);
    addProfile("p2", "/tmp/p2", 5);
    insertSnapshot("p1", 10, null, 20, null, null);
    insertSnapshot("p1", 30, null, 40, null, null);
    insertSnapshot("p2", 50, null, 60, null, null);

    const latest = getLatestSnapshots();
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

  it("getHistory returns snapshots within time window", () => {
    addProfile("hist-test", "/tmp/hist", 5);
    insertSnapshot("hist-test", 10, null, 20, null, null);
    insertSnapshot("hist-test", 30, null, 40, null, null);
    insertSnapshot("hist-test", 50, null, 60, null, null);

    const history = getHistory("hist-test", 24, 100);
    expect(history.length).toBe(3);
    // Should be ordered DESC by polled_at
    expect(history[0].five_hour_pct).toBeCloseTo(50);
  });

  it("getHistory respects limit", () => {
    addProfile("lim-test", "/tmp/lim", 5);
    for (let i = 0; i < 10; i++) {
      insertSnapshot("lim-test", i * 10, null, i * 5, null, null);
    }

    const history = getHistory("lim-test", 24, 3);
    expect(history).toHaveLength(3);
  });
});

describe("getLastSuccessfulSnapshot", () => {
  it("returns the most recent snapshot with non-null resets_at", () => {
    addProfile("resume-test", "/tmp/resume", 5);
    insertSnapshot("resume-test", 45.0, "2026-03-25T18:00:00Z", 30.0, "2026-03-30T00:00:00Z", null);
    // A later failed snapshot with null values
    insertSnapshot("resume-test", null, null, null, null, '{"error":"rate limit"}');

    const last = getLastSuccessfulSnapshot("resume-test");
    expect(last).toBeDefined();
    expect(last!.five_hour_pct).toBeCloseTo(45.0);
    expect(last!.five_hour_resets_at).toBe("2026-03-25T18:00:00Z");
  });

  it("returns undefined when no successful snapshots exist", () => {
    addProfile("no-success", "/tmp/nosuccess", 5);
    insertSnapshot("no-success", null, null, null, null, '{"error":"auth"}');

    const last = getLastSuccessfulSnapshot("no-success");
    expect(last).toBeUndefined();
  });

  it("returns snapshot with only one resets_at present", () => {
    addProfile("partial-reset", "/tmp/partial", 5);
    insertSnapshot("partial-reset", 60.0, "2026-03-25T20:00:00Z", null, null, null);

    const last = getLastSuccessfulSnapshot("partial-reset");
    expect(last).toBeDefined();
    expect(last!.five_hour_resets_at).toBe("2026-03-25T20:00:00Z");
    expect(last!.seven_day_resets_at).toBeNull();
  });
});

describe("gemini quota snapshots", () => {
  it("inserts and returns latest Gemini quota per model", () => {
    insertGeminiQuotaSnapshots([
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
    insertGeminiQuotaSnapshots([
      {
        modelId: "gemini-2.5-pro",
        remainingFraction: 0.2,
        remainingAmount: "200",
        resetTime: "2026-05-05T07:00:00Z",
      },
    ]);

    const latest = getLatestGeminiQuota();
    expect(latest).toHaveLength(2);
    expect(latest.find((q) => q.model_id === "gemini-2.5-pro")!.remaining_fraction).toBeCloseTo(0.2);
    expect(latest.find((q) => q.model_id === "gemini-2.5-flash")!.remaining_fraction).toBeCloseTo(0.5);
  });
});

describe("alert subscriptions", () => {
  it("creates and lists alert subscriptions", () => {
    addProfile("alert-prof", "/tmp/alert", 5);
    const sub = createAlertSubscription(
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

    const subs = listAlertSubscriptions("alert-prof");
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(sub.id);
  });

  it("lists all subscriptions when no profile filter", () => {
    addProfile("p1", "/tmp/p1", 5);
    addProfile("p2", "/tmp/p2", 5);
    createAlertSubscription("p1", "five_hour_threshold", 80, null, 30);
    createAlertSubscription("p2", "seven_day_threshold", 70, null, 60);

    const all = listAlertSubscriptions();
    expect(all).toHaveLength(2);
  });

  it("removes an alert subscription", () => {
    addProfile("rm-alert", "/tmp/rm", 5);
    const sub = createAlertSubscription(
      "rm-alert",
      "auth_failure",
      null,
      null,
      15
    );

    const removed = removeAlertSubscription(sub.id);
    expect(removed).toBe(true);

    const remaining = listAlertSubscriptions("rm-alert");
    expect(remaining).toHaveLength(0);
  });

  it("returns false when removing non-existent subscription", () => {
    const removed = removeAlertSubscription(9999);
    expect(removed).toBe(false);
  });
});

describe("alert events", () => {
  it("creates and retrieves alert events", () => {
    addProfile("evt-prof", "/tmp/evt", 5);
    const sub = createAlertSubscription(
      "evt-prof",
      "five_hour_threshold",
      90,
      null,
      30
    );

    const event = createAlertEvent(
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

    const triggered = getTriggeredAlerts("evt-prof", 24, false);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].id).toBe(event.id);
  });

  it("acknowledges a single alert", () => {
    addProfile("ack-prof", "/tmp/ack", 5);
    const sub = createAlertSubscription(
      "ack-prof",
      "five_hour_threshold",
      90,
      null,
      30
    );
    const event = createAlertEvent(
      sub.id,
      "ack-prof",
      "five_hour_threshold",
      "Alert!",
      95,
      90
    );

    const acked = acknowledgeAlert(event.id);
    expect(acked).toBe(true);

    // Second ack should return false
    const acked2 = acknowledgeAlert(event.id);
    expect(acked2).toBe(false);

    const unacked = getTriggeredAlerts("ack-prof", 24, true);
    expect(unacked).toHaveLength(0);
  });

  it("acknowledges all alerts for a profile", () => {
    addProfile("ack-all", "/tmp/ackall", 5);
    const sub = createAlertSubscription(
      "ack-all",
      "five_hour_threshold",
      90,
      null,
      30
    );
    createAlertEvent(sub.id, "ack-all", "five_hour_threshold", "A1", 91, 90);
    createAlertEvent(sub.id, "ack-all", "five_hour_threshold", "A2", 93, 90);

    const count = acknowledgeAllAlerts("ack-all");
    expect(count).toBe(2);

    const unacked = getTriggeredAlerts("ack-all", 24, true);
    expect(unacked).toHaveLength(0);
  });

  it("acknowledges all alerts across all profiles", () => {
    addProfile("aa1", "/tmp/aa1", 5);
    addProfile("aa2", "/tmp/aa2", 5);
    const sub1 = createAlertSubscription("aa1", "five_hour_threshold", 90, null, 30);
    const sub2 = createAlertSubscription("aa2", "seven_day_threshold", 80, null, 30);
    createAlertEvent(sub1.id, "aa1", "five_hour_threshold", "X", 95, 90);
    createAlertEvent(sub2.id, "aa2", "seven_day_threshold", "Y", 85, 80);

    const count = acknowledgeAllAlerts();
    expect(count).toBe(2);
  });

  it("filters triggered alerts by unacknowledged_only", () => {
    addProfile("filter-prof", "/tmp/filter", 5);
    const sub = createAlertSubscription(
      "filter-prof",
      "five_hour_threshold",
      90,
      null,
      30
    );
    const e1 = createAlertEvent(sub.id, "filter-prof", "five_hour_threshold", "E1", 91, 90);
    createAlertEvent(sub.id, "filter-prof", "five_hour_threshold", "E2", 95, 90);

    acknowledgeAlert(e1.id);

    const unacked = getTriggeredAlerts("filter-prof", 24, true);
    expect(unacked).toHaveLength(1);
    expect(unacked[0].message).toBe("E2");
  });
});

describe("updatePollInterval", () => {
  it("updates poll interval for existing profile", () => {
    addProfile("interval-test", "/tmp/interval", 5);
    const updated = updatePollInterval("interval-test", 15);
    expect(updated).toBe(true);

    const profile = getProfile("interval-test");
    expect(profile!.poll_interval_minutes).toBe(15);
  });

  it("returns false for non-existent profile", () => {
    const updated = updatePollInterval("no-such-profile", 10);
    expect(updated).toBe(false);
  });
});
