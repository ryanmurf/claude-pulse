import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { initDb, closeDb, addProfile, resolveAccount, mintIngestToken } from "../src/store.js";
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

async function fetchJson(pathname: string, headers: Record<string, string> = {}): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
      return await response.json();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-server-test-"));
  initDb(path.join(tmpDir, "test.db"));
  port = await getFreePort();
  startHttpServer(port);
});

afterEach(() => {
  stopHttpServer();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/profiles", () => {
  it("redacts stored profile API keys", async () => {
    addProfile("with-key", "/tmp/with-key", 5, "deepseek-balance", 10, "sk-secret");

    const profiles = await fetchJson("/api/profiles");

    expect(profiles).toEqual([
      expect.objectContaining({
        name: "with-key",
        api_key: "***",
      }),
    ]);
  });
});

describe("GET /api/me", () => {
  it("derives the account from X-Auth-Request-Email (auto-creates)", async () => {
    const me = (await fetchJson("/api/me", { "X-Auth-Request-Email": "alice@example.com" })) as any;
    expect(me.account).toBe("alice@example.com");
  });
  it("falls back to the default account when header is absent", async () => {
    const me = (await fetchJson("/api/me")) as any;
    expect(me.account).toBe("local");
  });
});

describe("POST /api/ingest", () => {
  it("401s without a valid bearer", async () => {
    const r = await req("POST", "/api/ingest", { body: { rollups: [] } });
    expect(r.status).toBe(401);
  });

  it("validates the token, attributes rows to the token's (account, machine), ignores body host", async () => {
    const acct = resolveAccount("ingest-user@example.com");
    const { plaintext } = mintIngestToken(acct.id, "laptop-1");

    const r = await req("POST", "/api/ingest", {
      headers: { Authorization: `Bearer ${plaintext}` },
      body: {
        // attacker tries to spoof account/machine in the body — must be ignored
        host: "ATTACKER",
        machine: "ATTACKER",
        rollups: [
          {
            profile: "claude-max",
            session_id: "sess-x",
            day: "2026-06-01",
            model: "claude-opus-4-8",
            settings: { service_tier: "standard" },
            tokens_in: 1000,
            tokens_out: 500,
            cache_write_5m: 100,
            cache_write_1h: 50,
            cache_read: 800,
          },
        ],
        context: [
          {
            profile: "claude-max",
            session_id: "sess-x",
            model: "claude-opus-4-8",
            context_tokens: 1234,
            context_pct: 0.6,
            effective_limit: 200000,
            last_active_at: new Date().toISOString(),
          },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.upserted).toBe(1);
    expect(r.json.context_upserted).toBe(1);

    // The report for the token's account must show the row attributed to laptop-1.
    const rep = (await fetchJson("/api/reports?days=90", { "X-Auth-Request-Email": "ingest-user@example.com" })) as any;
    expect(rep.account).toBe("ingest-user@example.com");
    expect(rep.profiles[0].by_machine.map((m: any) => m.key)).toContain("laptop-1");
    expect(rep.profiles[0].by_machine.map((m: any) => m.key)).not.toContain("ATTACKER");

    // Context grouped profile→machine→session, attributed to laptop-1.
    const ctx = (await fetchJson("/api/context", { "X-Auth-Request-Email": "ingest-user@example.com" })) as any;
    expect(ctx[0].profile).toBe("claude-max");
    expect(ctx[0].machines[0].machine).toBe("laptop-1");
  });

  it("rejects after the token is revoked", async () => {
    const acct = resolveAccount("rev-user@example.com");
    const { plaintext } = mintIngestToken(acct.id, "m1");
    const revoke = (await fetchJson("/api/ingest-tokens", { "X-Auth-Request-Email": "rev-user@example.com" })) as any[];
    await req("DELETE", `/api/ingest-tokens/${revoke[0].id}`, { headers: { "X-Auth-Request-Email": "rev-user@example.com" } });
    const r = await req("POST", "/api/ingest", { headers: { Authorization: `Bearer ${plaintext}` }, body: { rollups: [] } });
    expect(r.status).toBe(401);
  });
});

describe("account isolation over HTTP", () => {
  it("one account cannot read another's report rows", async () => {
    const a = resolveAccount("iso-a@example.com");
    const b = resolveAccount("iso-b@example.com");
    const ta = mintIngestToken(a.id, "ma").plaintext;
    const tb = mintIngestToken(b.id, "mb").plaintext;

    const mkBody = (model: string) => ({
      rollups: [{ profile: "claude-max", session_id: "s", day: "2026-06-01", model, tokens_in: 100, tokens_out: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 }],
    });
    await req("POST", "/api/ingest", { headers: { Authorization: `Bearer ${ta}` }, body: mkBody("claude-opus-4-8") });
    await req("POST", "/api/ingest", { headers: { Authorization: `Bearer ${tb}` }, body: mkBody("claude-sonnet-4-6") });

    const repA = (await fetchJson("/api/reports?days=90", { "X-Auth-Request-Email": "iso-a@example.com" })) as any;
    const repB = (await fetchJson("/api/reports?days=90", { "X-Auth-Request-Email": "iso-b@example.com" })) as any;
    // each account sees only its own model
    expect(repA.profiles[0].by_machine.map((m: any) => m.key)).toEqual(["ma"]);
    expect(repB.profiles[0].by_machine.map((m: any) => m.key)).toEqual(["mb"]);
  });
});

describe("GET/PUT /api/pricing", () => {
  it("returns merged defaults and applies an override", async () => {
    const hdr = { "X-Auth-Request-Email": "price@example.com" };
    const before = (await fetchJson("/api/pricing", hdr)) as any;
    expect(before.rows.length).toBeGreaterThan(0);
    const opus = before.rows.find((r: any) => r.model === "claude-opus-4" && r.settings_match_json === "{}");
    expect(opus.overridden).toBe(false);

    const put = await req("PUT", "/api/pricing", {
      headers: hdr,
      body: { model: "claude-opus-4", settings_match_json: "{}", input: 1, output: 2, cache_write_5m: 3, cache_write_1h: 4, cache_read: 5 },
    });
    expect(put.status).toBe(200);
    const opusAfter = put.json.rows.find((r: any) => r.model === "claude-opus-4" && r.settings_match_json === "{}");
    expect(opusAfter.overridden).toBe(true);
    expect(opusAfter.input).toBe(1);

    const del = await req("DELETE", "/api/pricing/claude-opus-4", { headers: hdr });
    expect(del.status).toBe(200);
    const after = (await fetchJson("/api/pricing", hdr)) as any;
    expect(after.rows.find((r: any) => r.model === "claude-opus-4" && r.settings_match_json === "{}").overridden).toBe(false);
  });
});
