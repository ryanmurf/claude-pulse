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
  getLatestSnapshots,
  getLatestSnapshot,
  getLatestGeminiQuota,
} from "../src/store.js";
import { startHttpServer, stopHttpServer } from "../src/server.js";

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
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw lastError;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-tele-test-"));
  await initDb(path.join(tmpDir, "test.db"));
  port = await getFreePort();
  startHttpServer(port);
});

afterEach(async () => {
  stopHttpServer();
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/ingest — snapshots", () => {
  it("accepts + stores usage snapshots scoped to the token's account + profile (latest-poll-wins)", async () => {
    const acct = await resolveAccount("snap-user@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "laptop-1");

    // First push.
    const r1 = await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        snapshots: [
          {
            profile: "claude-max",
            five_hour_pct: 12,
            five_hour_resets_at: "2026-06-07T20:00:00.000Z",
            seven_day_pct: 30,
            seven_day_resets_at: "2026-06-14T00:00:00.000Z",
            context_tokens: 1000,
            context_pct: 0.5,
            polled_at: "2026-06-07T10:00:00.000Z",
          },
        ],
      },
    });
    expect(r1.status).toBe(200);
    expect(r1.json.snapshots_upserted).toBe(1);

    // Second push (newer poll) — latest wins.
    const r2 = await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        snapshots: [
          {
            profile: "claude-max",
            five_hour_pct: 55,
            five_hour_resets_at: "2026-06-07T20:00:00.000Z",
            seven_day_pct: 40,
            seven_day_resets_at: "2026-06-14T00:00:00.000Z",
            polled_at: "2026-06-07T10:05:00.000Z",
          },
        ],
      },
    });
    expect(r2.status).toBe(200);

    // Read back via the store, scoped to this account.
    const latest = await getLatestSnapshot("claude-max", acct.id);
    expect(latest?.five_hour_pct).toBe(55);

    const all = await getLatestSnapshots(acct.id);
    const cm = all.find((s) => s.profile === "claude-max");
    expect(cm?.five_hour_pct).toBe(55);

    // Account isolation: the default/local account has no such snapshot.
    const local = await resolveAccount("local");
    const localSnap = await getLatestSnapshot("claude-max", local.id);
    expect(localSnap?.five_hour_pct ?? null).toBe(null);
  });

  it("rejects a snapshot whose resets_at regresses (stale reporter can't shadow fresh data)", async () => {
    const acct = await resolveAccount("stale-guard@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "fresh-machine");

    // Fresh content from an active machine.
    await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        snapshots: [
          {
            profile: "codex",
            five_hour_pct: 8,
            five_hour_resets_at: "2026-06-12T01:13:50.000Z",
            seven_day_pct: 3,
            seven_day_resets_at: "2026-06-18T03:50:52.000Z",
            polled_at: "2026-06-11T22:00:00.000Z",
          },
        ],
      },
    });

    // An idle machine re-publishes a previous window's content with a NEWER
    // polled_at (the 2026-06-11 tron/codex failure mode) — must not win.
    await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        snapshots: [
          {
            profile: "codex",
            five_hour_pct: 10,
            five_hour_resets_at: "2026-06-08T09:44:25.000Z",
            seven_day_pct: 77,
            seven_day_resets_at: "2026-06-11T02:13:16.000Z",
            polled_at: "2026-06-11T22:05:00.000Z",
          },
        ],
      },
    });

    const latest = await getLatestSnapshot("codex", acct.id);
    expect(latest?.seven_day_pct).toBe(3);
    expect(latest?.seven_day_resets_at).toBe("2026-06-18T03:50:52.000Z");

    // Same-window updates (equal resets_at, pct accumulating) still apply.
    await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        snapshots: [
          {
            profile: "codex",
            five_hour_pct: 9,
            five_hour_resets_at: "2026-06-12T01:13:50.000Z",
            seven_day_pct: 4,
            seven_day_resets_at: "2026-06-18T03:50:52.000Z",
            polled_at: "2026-06-11T22:10:00.000Z",
          },
        ],
      },
    });
    expect((await getLatestSnapshot("codex", acct.id))?.seven_day_pct).toBe(4);
  });

  it("tolerates sub-second resets_at jitter from the Anthropic usage API (claude-hd-max 2026-06-12 wedge)", async () => {
    const acct = await resolveAccount("jitter-guard@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "tron");

    // A poll that happened to carry Anthropic's raw microsecond noise lands first.
    await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        snapshots: [
          {
            profile: "claude-hd-max",
            five_hour_pct: 87,
            five_hour_resets_at: "2026-06-12T00:30:00.867602+00:00",
            seven_day_pct: 60,
            seven_day_resets_at: "2026-06-14T11:00:00.867626+00:00",
            polled_at: "2026-06-12T00:00:01.927Z",
          },
        ],
      },
    });

    // Later polls report the same windows second-aligned (.000) — a few hundred
    // ms "older". Must be treated as the same window and accepted, not wedged.
    await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        snapshots: [
          {
            profile: "claude-hd-max",
            five_hour_pct: 12,
            five_hour_resets_at: "2026-06-12T05:30:00.000Z",
            seven_day_pct: 61,
            seven_day_resets_at: "2026-06-14T11:00:00.000Z",
            polled_at: "2026-06-12T02:00:04.000Z",
          },
        ],
      },
    });

    const latest = await getLatestSnapshot("claude-hd-max", acct.id);
    expect(latest?.five_hour_pct).toBe(12);
    expect(latest?.seven_day_pct).toBe(61);

    // Beyond the tolerance it is still a regression — days-old content loses.
    await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        snapshots: [
          {
            profile: "claude-hd-max",
            five_hour_pct: 99,
            five_hour_resets_at: "2026-06-12T05:30:00.000Z",
            seven_day_pct: 99,
            seven_day_resets_at: "2026-06-14T05:00:00.000Z",
            polled_at: "2026-06-12T02:05:00.000Z",
          },
        ],
      },
    });
    expect((await getLatestSnapshot("claude-hd-max", acct.id))?.seven_day_pct).toBe(61);
  });

  it("is account-scoped — two accounts don't see each other's snapshots", async () => {
    const a = await resolveAccount("snap-a@example.com");
    const b = await resolveAccount("snap-b@example.com");
    const ta = (await mintIngestToken(a.id, "ma")).plaintext;
    const tb = (await mintIngestToken(b.id, "mb")).plaintext;

    await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${ta}` },
      body: { snapshots: [{ profile: "claude-max", five_hour_pct: 11, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null }] },
    });
    await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${tb}` },
      body: { snapshots: [{ profile: "claude-max", five_hour_pct: 99, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null }] },
    });

    expect((await getLatestSnapshot("claude-max", a.id))?.five_hour_pct).toBe(11);
    expect((await getLatestSnapshot("claude-max", b.id))?.five_hour_pct).toBe(99);
  });
});

describe("POST /api/ingest — gemini", () => {
  it("accepts + stores gemini quota scoped to the token's account, and /api/gemini-quota reads it back per-account", async () => {
    const acct = await resolveAccount("gem-user@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "laptop-1");

    const r = await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        gemini: [
          { model_id: "gemini-2.5-pro", remaining_fraction: 0.4, remaining_amount: "40", reset_time: "2026-06-08T00:00:00.000Z" },
          { model_id: "gemini-2.5-flash", remaining_fraction: 0.9, remaining_amount: null, reset_time: null },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.gemini_upserted).toBe(2);

    // Store read, account-scoped.
    const stored = await getLatestGeminiQuota(acct.id);
    expect(stored.map((s) => s.model_id).sort()).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);

    // HTTP read, account-scoped via X-Auth-Request-Email.
    const got = await req("GET", "/api/gemini-quota", { headers: { "X-Auth-Request-Email": "gem-user@example.com" } });
    expect(got.status).toBe(200);
    const pro = got.json.find((g: any) => g.model_id === "gemini-2.5-pro");
    expect(pro.used_pct).toBeCloseTo(60, 5);

    // Another account sees nothing.
    const other = await req("GET", "/api/gemini-quota", { headers: { "X-Auth-Request-Email": "other@example.com" } });
    expect(other.json).toEqual([]);
  });
});

describe("POST /api/ingest — combined extended body", () => {
  it("accepts rollups + context + snapshots + gemini in one request", async () => {
    const acct = await resolveAccount("combo@example.com");
    const { plaintext } = await mintIngestToken(acct.id, "m1");
    const r = await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        rollups: [{ profile: "claude-max", session_id: "s", day: "2026-06-01", model: "claude-opus-4-8", tokens_in: 1, tokens_out: 1, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 }],
        context: [{ profile: "claude-max", session_id: "s", model: "claude-opus-4-8", context_tokens: 1, context_pct: 0, effective_limit: 200000, last_active_at: new Date().toISOString() }],
        snapshots: [{ profile: "claude-max", five_hour_pct: 5, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null }],
        gemini: [{ model_id: "gemini-2.5-pro", remaining_fraction: 0.5, remaining_amount: null, reset_time: null }],
      },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, upserted: 1, context_upserted: 1, snapshots_upserted: 1, gemini_upserted: 1 });
  });
});
