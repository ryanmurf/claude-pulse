import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initDb,
  closeDb,
  resolveAccount,
  getAccount,
  listAccounts,
  addProfile,
  insertSnapshot,
  getLatestSnapshots,
  getLatestSnapshot,
  getHistory,
  mintIngestToken,
  listIngestTokens,
  revokeIngestToken,
  validateIngestToken,
  hashIngestToken,
  upsertMachine,
  listMachines,
  upsertTokenUsage,
  getTokenUsage,
  upsertContextSession,
  getActiveContextSessions,
  sweepStaleContextSessions,
  upsertPricingOverride,
  getPricingOverrides,
  deletePricingOverride,
  getPricingDefaults,
  getFineTokenReport,
  DEFAULT_ACCOUNT_IDENTITY,
} from "../src/store.js";
import type { TokenUsageInput } from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-mt-test-"));
  initDb(path.join(tmpDir, "test.db"));
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function usageRow(accountId: number, over: Partial<TokenUsageInput> = {}): TokenUsageInput {
  return {
    account_id: accountId,
    profile: "claude-max",
    machine: "tron",
    session_id: "sess-1",
    model: "claude-opus-4-8",
    settings_hash: "{}",
    settings_json: "{}",
    day: "2026-06-01",
    tokens_in: 100,
    tokens_out: 50,
    cache_write_5m: 200,
    cache_write_1h: 0,
    cache_read: 800,
    source: "local",
    ...over,
  };
}

describe("accounts", () => {
  it("seeds the default account and auto-creates on first sight", () => {
    expect(getAccount(DEFAULT_ACCOUNT_IDENTITY)).toBeDefined();
    const a = resolveAccount("alice@example.com");
    expect(a.identity).toBe("alice@example.com");
    // idempotent
    const a2 = resolveAccount("alice@example.com");
    expect(a2.id).toBe(a.id);
    expect(listAccounts().length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the default account for null/blank identity", () => {
    const a = resolveAccount(null);
    expect(a.identity).toBe(DEFAULT_ACCOUNT_IDENTITY);
    const b = resolveAccount("   ");
    expect(b.identity).toBe(DEFAULT_ACCOUNT_IDENTITY);
  });
});

describe("account isolation — snapshots", () => {
  it("one account cannot read another's snapshots", () => {
    addProfile("claude-max", "/tmp/cm", 5);
    const a = resolveAccount("a@x.com");
    const b = resolveAccount("b@x.com");
    insertSnapshot("claude-max", 40, null, 30, null, null, null, a.id);
    insertSnapshot("claude-max", 90, null, 80, null, null, null, b.id);

    expect(getLatestSnapshot("claude-max", a.id)!.five_hour_pct).toBe(40);
    expect(getLatestSnapshot("claude-max", b.id)!.five_hour_pct).toBe(90);
    expect(getLatestSnapshots(a.id).length).toBe(1);
    expect(getHistory("claude-max", 24, 100, a.id).every((s) => s.account_id === a.id)).toBe(true);
  });
});

describe("ingest tokens", () => {
  it("mints once (plaintext), stores only hash, validates + stamps + revokes", () => {
    const a = resolveAccount("a@x.com");
    const { plaintext, token } = mintIngestToken(a.id, "laptop");
    expect(plaintext.startsWith("cp_")).toBe(true);
    expect(token.machine).toBe("laptop");

    // Only the hash is stored — list never returns plaintext.
    const masked = listIngestTokens(a.id);
    expect(masked.length).toBe(1);
    expect((masked[0] as any).token).toBeUndefined();
    expect(masked[0].token_preview).toContain("…");

    // Validate by plaintext → matches via hash; stamps last_used_at.
    const v = validateIngestToken(plaintext);
    expect(v).toBeDefined();
    expect(v!.account_id).toBe(a.id);
    expect(v!.machine).toBe("laptop");
    const afterUse = listIngestTokens(a.id)[0];
    expect(afterUse.last_used_at).not.toBeNull();

    // Hash matches what we'd compute.
    expect(v!.token_hash).toBe(hashIngestToken(plaintext));

    // Revoke → no longer validates.
    expect(revokeIngestToken(a.id, token.id)).toBe(true);
    expect(validateIngestToken(plaintext)).toBeUndefined();
  });

  it("a wrong/garbage bearer does not validate", () => {
    const a = resolveAccount("a@x.com");
    mintIngestToken(a.id, "laptop");
    expect(validateIngestToken("cp_not-a-real-token")).toBeUndefined();
  });

  it("scopes revoke to the owning account", () => {
    const a = resolveAccount("a@x.com");
    const b = resolveAccount("b@x.com");
    const { token } = mintIngestToken(a.id, "laptop");
    // b cannot revoke a's token
    expect(revokeIngestToken(b.id, token.id)).toBe(false);
  });
});

describe("machines", () => {
  it("upserts unique per (account,name)", () => {
    const a = resolveAccount("a@x.com");
    upsertMachine(a.id, "tron");
    upsertMachine(a.id, "tron");
    upsertMachine(a.id, "laptop");
    expect(listMachines(a.id).map((m) => m.name).sort()).toEqual(["laptop", "tron"]);
  });
});

describe("token_usage fine grain", () => {
  it("upserts and replaces on the natural key, isolated per account", () => {
    const a = resolveAccount("a@x.com");
    const b = resolveAccount("b@x.com");
    upsertTokenUsage(usageRow(a.id, { tokens_in: 100 }));
    upsertTokenUsage(usageRow(a.id, { tokens_in: 999 })); // same key → replace
    upsertTokenUsage(usageRow(b.id, { tokens_in: 7 }));

    const aRows = getTokenUsage({ accountId: a.id });
    expect(aRows.length).toBe(1);
    expect(aRows[0].tokens_in).toBe(999);
    expect(getTokenUsage({ accountId: b.id })[0].tokens_in).toBe(7);
  });

  it("keeps separate rows per session/model/settings", () => {
    const a = resolveAccount("a@x.com");
    upsertTokenUsage(usageRow(a.id, { session_id: "s1" }));
    upsertTokenUsage(usageRow(a.id, { session_id: "s2" }));
    upsertTokenUsage(usageRow(a.id, { session_id: "s1", model: "claude-sonnet-4-6" }));
    upsertTokenUsage(usageRow(a.id, { session_id: "s1", settings_hash: '{"x":1}', settings_json: '{"x":1}' }));
    expect(getTokenUsage({ accountId: a.id }).length).toBe(4);
  });
});

describe("getFineTokenReport", () => {
  it("rolls up session-agnostic to (profile) with by_machine + by_day", () => {
    const a = resolveAccount("a@x.com");
    const today = new Date().toISOString().slice(0, 10);
    upsertTokenUsage(usageRow(a.id, { day: today, machine: "tron", session_id: "s1", tokens_in: 100, tokens_out: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 }));
    upsertTokenUsage(usageRow(a.id, { day: today, machine: "tron", session_id: "s2", tokens_in: 50, tokens_out: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 }));
    upsertTokenUsage(usageRow(a.id, { day: today, machine: "laptop", session_id: "s3", tokens_in: 25, tokens_out: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 }));

    const rep = getFineTokenReport({ accountId: a.id, identity: a.identity, days: 30 });
    expect(rep.profiles.length).toBe(1);
    const p = rep.profiles[0];
    // session-agnostic: 100 + 50 + 25 = 175 across two machines
    expect(p.tokens_in).toBe(175);
    expect(p.by_machine.length).toBe(2);
    expect(p.by_machine.find((m) => m.key === "tron")!.tokens_in).toBe(150);
    expect(p.drill).toBeUndefined();
  });

  it("supports drilling to session/model/machine", () => {
    const a = resolveAccount("a@x.com");
    const today = new Date().toISOString().slice(0, 10);
    upsertTokenUsage(usageRow(a.id, { day: today, session_id: "s1", tokens_in: 10 }));
    upsertTokenUsage(usageRow(a.id, { day: today, session_id: "s2", tokens_in: 20 }));
    const rep = getFineTokenReport({ accountId: a.id, identity: a.identity, days: 30, drill: "session" });
    const drill = rep.profiles[0].drill!;
    expect(drill.map((d) => d.key).sort()).toEqual(["s1", "s2"]);
  });

  it("recomputes cost from grains × effective rate (override re-prices history)", () => {
    const a = resolveAccount("a@x.com");
    const today = new Date().toISOString().slice(0, 10);
    upsertTokenUsage(usageRow(a.id, { day: today, model: "claude-opus-4-8", tokens_in: 1_000_000, tokens_out: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 }));

    const before = getFineTokenReport({ accountId: a.id, identity: a.identity, days: 30 });
    // default opus input = 15 / 1M
    expect(before.profiles[0].cost_usd).toBeCloseTo(15, 6);

    upsertPricingOverride(a.id, { model: "claude-opus-4", settings_match_json: "{}", input: 1, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 });
    const after = getFineTokenReport({ accountId: a.id, identity: a.identity, days: 30 });
    expect(after.profiles[0].cost_usd).toBeCloseTo(1, 6);

    // Reset override → back to default.
    expect(deletePricingOverride(a.id, "claude-opus-4")).toBe(1);
    const reset = getFineTokenReport({ accountId: a.id, identity: a.identity, days: 30 });
    expect(reset.profiles[0].cost_usd).toBeCloseTo(15, 6);
  });
});

describe("pricing storage", () => {
  it("seeds placeholder defaults and isolates overrides per account", () => {
    const a = resolveAccount("a@x.com");
    const b = resolveAccount("b@x.com");
    expect(getPricingDefaults().length).toBeGreaterThan(0);
    upsertPricingOverride(a.id, { model: "gpt-5", settings_match_json: "{}", input: 9, output: 9, cache_write_5m: 9, cache_write_1h: 9, cache_read: 9 });
    expect(getPricingOverrides(a.id).length).toBe(1);
    expect(getPricingOverrides(b.id).length).toBe(0);
  });
});

describe("context_sessions expiry", () => {
  it("excludes + sweeps sessions older than 1 day", () => {
    const a = resolveAccount("a@x.com");
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    upsertContextSession({
      account_id: a.id, profile: "claude-max", machine: "tron", session_id: "live",
      model: "claude-opus-4-8", settings_json: "{}", context_tokens: 1000, context_pct: 5,
      effective_limit: 200000, last_active_at: now,
    });
    upsertContextSession({
      account_id: a.id, profile: "claude-max", machine: "tron", session_id: "stale",
      model: "claude-opus-4-8", settings_json: "{}", context_tokens: 1000, context_pct: 5,
      effective_limit: 200000, last_active_at: old,
    });

    const active = getActiveContextSessions(a.id);
    expect(active.map((s) => s.session_id)).toEqual(["live"]);

    const swept = sweepStaleContextSessions();
    expect(swept).toBe(1);
    // After sweep, stale row is gone entirely.
    expect(getActiveContextSessions(a.id).length).toBe(1);
  });
});
