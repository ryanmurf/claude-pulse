import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  initDb,
  closeDb,
  getBackend,
  resolveAccount,
  addProfile,
  insertSnapshot,
  getLatestSnapshot,
  getLatestSnapshots,
  getHistory,
  upsertTokenUsage,
  getFineTokenReport,
  upsertTokenRollup,
  getTokenReport,
  getTokenRollups,
  createAlertSubscription,
  createAlertEvent,
  getTriggeredAlerts,
  acknowledgeAlert,
  mintIngestToken,
  validateIngestToken,
  upsertContextSession,
  getActiveContextSessions,
  sweepStaleContextSessions,
} from "../src/store.js";

// Postgres-backend PARITY tests. These run ONLY when CLAUDE_PULSE_TEST_PG_URL is
// set, so the default `npm test` stays green without a Postgres. They prove the
// same isolation / upsert / report behaviour against PG as the SQLite suite.
//
//   CLAUDE_PULSE_TEST_PG_URL=postgres://user:pass@host:5432/db npm test
//
// The target DB is wiped (TRUNCATE … RESTART IDENTITY CASCADE) before each test.

const PG_URL = process.env.CLAUDE_PULSE_TEST_PG_URL;
const d = PG_URL ? describe : describe.skip;

d("Postgres backend parity", () => {
  beforeAll(async () => {
    // Route initDb to Postgres for this suite.
    process.env.CLAUDE_PULSE_PG_URL = PG_URL;
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
    delete process.env.CLAUDE_PULSE_PG_URL;
  });

  beforeEach(async () => {
    const be = getBackend()!;
    // Wipe all data so each test starts clean; re-seed the default account +
    // pricing by truncating then re-running the schema seed paths is overkill —
    // we only need the tables empty and the default account present.
    await be.exec(
      `TRUNCATE TABLE usage_snapshots, token_usage, token_rollups, alert_events,
        alert_subscriptions, ingest_tokens, machines, context_sessions,
        pricing_overrides, profiles, gemini_quota RESTART IDENTITY CASCADE`,
    );
    // accounts intentionally NOT truncated so the seeded default account stays;
    // tests resolve their own accounts on top.
  });

  it("isolates reads by account_id (no cross-account leakage)", async () => {
    const a = await resolveAccount("pg-a@example.com");
    const b = await resolveAccount("pg-b@example.com");
    await addProfile("claude-max", "/tmp/cm", 5, "anthropic-oauth", null, null, a.id);
    await addProfile("claude-max-b", "/tmp/cmb", 5, "anthropic-oauth", null, null, b.id);

    await insertSnapshot("claude-max", 90, null, 80, null, null, null, a.id);
    await insertSnapshot("claude-max-b", 10, null, 20, null, null, null, b.id);

    const aSnap = await getLatestSnapshot("claude-max", a.id);
    expect(aSnap!.five_hour_pct).toBe(90);
    // b cannot see a's profile snapshot
    expect(await getLatestSnapshot("claude-max", b.id)).toBeUndefined();
    expect((await getLatestSnapshots(a.id)).length).toBe(1);
    expect((await getHistory("claude-max", 24, 100, a.id)).length).toBe(1);
  });

  it("upserts token_usage with ON CONFLICT REPLACE semantics", async () => {
    const a = await resolveAccount("pg-upsert@example.com");
    const base = {
      account_id: a.id,
      profile: "claude-max",
      machine: "tron",
      session_id: "s1",
      model: "claude-opus-4-8",
      settings_hash: "{}",
      settings_json: "{}",
      day: "2026-06-01",
      tokens_out: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_read: 0,
      source: "local" as const,
    };
    await upsertTokenUsage({ ...base, tokens_in: 100 });
    await upsertTokenUsage({ ...base, tokens_in: 999 });
    const rep = await getFineTokenReport({ accountId: a.id, identity: a.identity, days: 3650 });
    expect(rep.profiles.length).toBe(1);
    expect(rep.profiles[0].tokens_in).toBe(999); // replaced, not summed
  });

  it("token_rollups upsert-replace + getTokenReport aggregation parity", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const row = (over: Record<string, unknown>) => ({
      profile: "claude-max", host: "tron", day: today, model: "claude-opus-4-8",
      input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
      cost_usd: 0, source: "local" as const, ...over,
    });
    await upsertTokenRollup(row({ host: "tron", day: today, input_tokens: 100, cost_usd: 2 }));
    await upsertTokenRollup(row({ host: "laptop", day: today, input_tokens: 50, cost_usd: 1 }));
    await upsertTokenRollup(row({ host: "tron", day: yesterday, input_tokens: 25, cost_usd: 0.5 }));
    // replace same key
    await upsertTokenRollup(row({ host: "tron", day: today, input_tokens: 200, cost_usd: 4 }));

    expect((await getTokenRollups()).length).toBe(3);
    const report = await getTokenReport({ granularity: "daily", days: 30 });
    const p = report.profiles[0];
    expect(p.input_tokens).toBe(275); // 200 (replaced) + 50 + 25
    expect(p.cost_usd).toBeCloseTo(5.5, 6);
    expect(p.by_host.length).toBe(2);
    expect(p.by_day.length).toBe(2);
  });

  it("alert lifecycle + account-scoped acknowledge", async () => {
    const a = await resolveAccount("pg-alert@example.com");
    const other = await resolveAccount("pg-alert-other@example.com");
    await addProfile("claude-max", "/tmp/cm", 5, "anthropic-oauth", null, null, a.id);
    const sub = await createAlertSubscription(a.id, "claude-max", "five_hour_threshold", 90, null, 30);
    const evt = await createAlertEvent(a.id, sub.id, "claude-max", "five_hour_threshold", "msg", 95, 90);

    expect((await getTriggeredAlerts(a.id, "claude-max", 24, false)).length).toBe(1);
    // Another account cannot acknowledge a's event (IDOR closed).
    expect(await acknowledgeAlert(other.id, evt.id)).toBe(false);
    expect(await acknowledgeAlert(a.id, evt.id)).toBe(true);
    expect((await getTriggeredAlerts(a.id, "claude-max", 24, true)).length).toBe(0);
  });

  it("ingest token mint + validate (hash lookup) round-trips", async () => {
    const a = await resolveAccount("pg-tok@example.com");
    const { plaintext, token } = await mintIngestToken(a.id, "laptop");
    const valid = await validateIngestToken(plaintext);
    expect(valid?.id).toBe(token.id);
    expect(await validateIngestToken("cp_bogus")).toBeUndefined();
  });

  it("context_sessions stale-window read + sweep (tsGte/tsLt parity)", async () => {
    const a = await resolveAccount("pg-ctx@example.com");
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await upsertContextSession({
      account_id: a.id, profile: "claude-max", machine: "tron", session_id: "live",
      model: "claude-opus-4-8", settings_json: "{}", context_tokens: 100, context_pct: 1,
      effective_limit: 200000, last_active_at: fresh,
    });
    await upsertContextSession({
      account_id: a.id, profile: "claude-max", machine: "tron", session_id: "old",
      model: "claude-opus-4-8", settings_json: "{}", context_tokens: 100, context_pct: 1,
      effective_limit: 200000, last_active_at: stale,
    });
    // Only the fresh session is returned by the active read.
    const active = await getActiveContextSessions(a.id);
    expect(active.map((s) => s.session_id)).toEqual(["live"]);
    // Sweep removes the stale one.
    const removed = await sweepStaleContextSessions();
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});
