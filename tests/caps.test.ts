import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  initDb,
  closeDb,
  resolveAccount,
  mintIngestToken,
  upsertTokenUsage,
  upsertContextSession,
  countTokenUsageRows,
  countContextSessions,
  countActiveIngestTokens,
  DEFAULT_ACCOUNT_IDENTITY,
} from "../src/store.js";
import {
  startHttpServer,
  stopHttpServer,
  _resetIngestRateLimit,
  _resetCapCaches,
} from "../src/server.js";

let tmpDir: string;
let port: number;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

async function req(
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

const emailHdr = (e: string) => ({ "X-Auth-Request-Email": e });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const CAP_ENVS = [
  "CLAUDE_PULSE_MAX_TOKEN_ROWS_PER_ACCOUNT",
  "CLAUDE_PULSE_MAX_CONTEXT_SESSIONS_PER_ACCOUNT",
  "CLAUDE_PULSE_MAX_TOKENS_PER_ACCOUNT",
  "CLAUDE_PULSE_MAX_ROWS_PER_REQUEST",
];

beforeEach(async () => {
  // Small caps so over-cap behavior is cheap to exercise.
  process.env.CLAUDE_PULSE_MAX_TOKEN_ROWS_PER_ACCOUNT = "2";
  process.env.CLAUDE_PULSE_MAX_CONTEXT_SESSIONS_PER_ACCOUNT = "2";
  process.env.CLAUDE_PULSE_MAX_TOKENS_PER_ACCOUNT = "2";
  process.env.CLAUDE_PULSE_MAX_ROWS_PER_REQUEST = "3";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-caps-test-"));
  await initDb(path.join(tmpDir, "test.db"));
  port = await getFreePort();
  startHttpServer(port);
  _resetIngestRateLimit();
  _resetCapCaches();
});

afterEach(async () => {
  stopHttpServer();
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const e of CAP_ENVS) delete process.env[e];
});

/** Seed a token_usage row directly (bypasses ingest, so it pre-loads the table). */
async function seedRollup(accountId: number, machine: string, day: string, session: string): Promise<void> {
  await upsertTokenUsage({
    account_id: accountId,
    profile: "claude-max",
    machine,
    session_id: session,
    model: "claude-opus-4-8",
    settings_hash: "{}",
    settings_json: "{}",
    day,
    tokens_in: 100,
    tokens_out: 50,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    source: "ingest",
  });
}

const mkRollup = (day: string, session: string, model = "claude-opus-4-8") => ({
  profile: "claude-max",
  session_id: session,
  day,
  model,
  settings: {},
  tokens_in: 100,
  tokens_out: 50,
  cache_write_5m: 0,
  cache_write_1h: 0,
  cache_read: 0,
});

const mkCtx = (session: string) => ({
  profile: "claude-max",
  session_id: session,
  model: "claude-opus-4-8",
  context_tokens: 1234,
  context_pct: 0.5,
  effective_limit: 200000,
  last_active_at: new Date().toISOString(),
});

describe("per-account token_usage row cap", () => {
  it("rejects NEW keys with 429 once at/over the cap", async () => {
    const acct = await resolveAccount("cap-rows@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "m1");
    // Fill to the cap (2 distinct keys).
    await seedRollup(acct.id, "m1", "2026-06-01", "s1");
    await seedRollup(acct.id, "m1", "2026-06-02", "s2");
    expect(await countTokenUsageRows(acct.id)).toBe(2);

    // A brand-new key is rejected with 429 (nothing else in the batch).
    const r = await req("POST", "/api/ingest", {
      headers: bearer(plaintext),
      body: { rollups: [mkRollup("2026-06-03", "s3")] },
    });
    expect(r.status).toBe(429);
    expect(r.json.upserted).toBe(0);
    expect(r.json.token_rows_rejected).toBe(1);
    // The new key was NOT written.
    expect(await countTokenUsageRows(acct.id)).toBe(2);
  });

  it("still allows upserts that UPDATE an existing row while at cap", async () => {
    const acct = await resolveAccount("cap-update@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "m1");
    await seedRollup(acct.id, "m1", "2026-06-01", "s1");
    await seedRollup(acct.id, "m1", "2026-06-02", "s2");

    // Re-push an existing key (same unique tuple) — must succeed (200, upserted=1).
    const r = await req("POST", "/api/ingest", {
      headers: bearer(plaintext),
      body: { rollups: [mkRollup("2026-06-01", "s1")] },
    });
    expect(r.status).toBe(200);
    expect(r.json.upserted).toBe(1);
    expect(await countTokenUsageRows(acct.id)).toBe(2); // no growth
  });
});

describe("per-account context_sessions cap", () => {
  it("rejects new sessions with 429 once at cap, still updates existing", async () => {
    const acct = await resolveAccount("cap-ctx@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "m1");
    // Fill context table to cap via ingest.
    await req("POST", "/api/ingest", { headers: bearer(plaintext), body: { context: [mkCtx("c1")] } });
    await req("POST", "/api/ingest", { headers: bearer(plaintext), body: { context: [mkCtx("c2")] } });
    expect(await countContextSessions(acct.id)).toBe(2);

    // New session rejected.
    const rNew = await req("POST", "/api/ingest", { headers: bearer(plaintext), body: { context: [mkCtx("c3")] } });
    expect(rNew.status).toBe(429);
    expect(rNew.json.context_rows_rejected).toBe(1);
    expect(await countContextSessions(acct.id)).toBe(2);

    // Existing session updates fine.
    const rUpd = await req("POST", "/api/ingest", { headers: bearer(plaintext), body: { context: [mkCtx("c1")] } });
    expect(rUpd.status).toBe(200);
    expect(rUpd.json.context_upserted).toBe(1);
  });
});

describe("per-account machine/token cap on mint", () => {
  it("rejects mint past the cap with 409", async () => {
    const hdr = emailHdr("cap-mint@example.com");
    const r1 = await req("POST", "/api/ingest-tokens", { headers: hdr, body: { machine: "m1" } });
    const r2 = await req("POST", "/api/ingest-tokens", { headers: hdr, body: { machine: "m2" } });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const r3 = await req("POST", "/api/ingest-tokens", { headers: hdr, body: { machine: "m3" } });
    expect(r3.status).toBe(409);
    expect(r3.json.error).toMatch(/limit/i);
  });
});

describe("per-request row count cap", () => {
  it("returns 413 when one /api/ingest call carries too many rows", async () => {
    const acct = await resolveAccount("cap-perreq@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "m1");
    // cap is 3 rows/request; send 4 (rollups + context combined).
    const r = await req("POST", "/api/ingest", {
      headers: bearer(plaintext),
      body: {
        rollups: [mkRollup("2026-06-01", "s1"), mkRollup("2026-06-02", "s2"), mkRollup("2026-06-03", "s3")],
        context: [mkCtx("c1")],
      },
    });
    expect(r.status).toBe(413);
  });
});

describe("local/DEFAULT account is exempt from caps", () => {
  it("allows unbounded new rows + mints past the cap for the default account", async () => {
    const local = await resolveAccount(DEFAULT_ACCOUNT_IDENTITY);
    const { plaintext } = await mintIngestToken(local.id, "tron");
    // Pre-fill beyond cap.
    await seedRollup(local.id, "tron", "2026-06-01", "s1");
    await seedRollup(local.id, "tron", "2026-06-02", "s2");
    await seedRollup(local.id, "tron", "2026-06-03", "s3");

    // A brand-new key still succeeds (exempt), and a big batch isn't 413'd.
    const r = await req("POST", "/api/ingest", {
      headers: bearer(plaintext),
      body: {
        rollups: [
          mkRollup("2026-06-04", "s4"),
          mkRollup("2026-06-05", "s5"),
          mkRollup("2026-06-06", "s6"),
          mkRollup("2026-06-07", "s7"),
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.upserted).toBe(4);

    // Mint past the token cap (cap=2) — exempt.
    await mintIngestToken(local.id, "tron-b");
    const r3 = await req("POST", "/api/ingest-tokens", {
      headers: emailHdr(DEFAULT_ACCOUNT_IDENTITY),
      body: { machine: "tron-c" },
    });
    expect(r3.status).toBe(201);
    expect(await countActiveIngestTokens(local.id)).toBeGreaterThan(2);
  });
});

describe("limits reported on /api/me and /api/limits", () => {
  it("/api/me includes a limits block with usage vs caps", async () => {
    const acct = await resolveAccount("cap-me@example.com");
    await mintIngestToken(acct.id, "m1");
    await seedRollup(acct.id, "m1", "2026-06-01", "s1");

    const me = (await req("GET", "/api/me", { headers: emailHdr("cap-me@example.com") })).json;
    expect(me.limits).toBeDefined();
    expect(me.limits.exempt).toBe(false);
    expect(me.limits.token_rows).toBe(1);
    expect(me.limits.token_rows_cap).toBe(2);
    expect(me.limits.machines).toBe(1);
    expect(me.limits.machines_cap).toBe(2);
    expect(me.limits.context_sessions_cap).toBe(2);
    expect(me.limits.max_rows_per_request).toBe(3);
  });

  it("/api/limits reports exempt:true with null caps for the default account", async () => {
    const limits = (await req("GET", "/api/limits", { headers: emailHdr(DEFAULT_ACCOUNT_IDENTITY) })).json;
    expect(limits.exempt).toBe(true);
    expect(limits.token_rows_cap).toBeNull();
    expect(limits.machines_cap).toBeNull();
    expect(limits.context_sessions_cap).toBeNull();
  });
});
