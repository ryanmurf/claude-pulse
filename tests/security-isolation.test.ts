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
  addProfile,
  createAlertSubscription,
  createAlertEvent,
  listAlertSubscriptions,
  getTriggeredAlerts,
  mintIngestToken,
} from "../src/store.js";
import { startHttpServer, stopHttpServer, esc, _resetIngestRateLimit } from "../src/server.js";

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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-iso-test-"));
  initDb(path.join(tmpDir, "test.db"));
  port = await getFreePort();
  startHttpServer(port);
  _resetIngestRateLimit();
});

afterEach(() => {
  stopHttpServer();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PULSE_TRUSTED_PROXY_SECRET;
  delete process.env.CLAUDE_PULSE_SINGLE_TENANT;
});

// ── H1/H3 — subscription + alert IDOR isolation ──────────────────────────────

describe("H1/H3 — subscription/alert isolation (IDOR)", () => {
  it("account B cannot delete account A's subscription (404, row survives)", async () => {
    const a = resolveAccount("a@x.com");
    const b = resolveAccount("b@x.com");
    addProfile("pa", "/tmp/pa", 5, "anthropic-oauth", null, null, a.id);
    const sub = createAlertSubscription(a.id, "pa", "five_hour_threshold", 90, null, 30);

    // B attempts to delete A's subscription by id.
    const del = await req("DELETE", `/api/subscriptions/${sub.id}`, { headers: emailHdr("b@x.com") });
    expect(del.status).toBe(404);

    // A's subscription must still exist.
    expect(listAlertSubscriptions(a.id).map((s) => s.id)).toContain(sub.id);
    // And B never had it.
    void b;
  });

  it("account B cannot read account A's subscriptions", async () => {
    const a = resolveAccount("a@x.com");
    resolveAccount("b@x.com");
    addProfile("pa", "/tmp/pa", 5, "anthropic-oauth", null, null, a.id);
    createAlertSubscription(a.id, "pa", "five_hour_threshold", 90, null, 30);

    const aView = await req("GET", "/api/subscriptions", { headers: emailHdr("a@x.com") });
    expect(aView.json.length).toBe(1);
    const bView = await req("GET", "/api/subscriptions", { headers: emailHdr("b@x.com") });
    expect(bView.json.length).toBe(0);
  });

  it("account B cannot acknowledge account A's alert (404, stays unacked)", async () => {
    const a = resolveAccount("a@x.com");
    resolveAccount("b@x.com");
    addProfile("pa", "/tmp/pa", 5, "anthropic-oauth", null, null, a.id);
    const sub = createAlertSubscription(a.id, "pa", "five_hour_threshold", 90, null, 30);
    const evt = createAlertEvent(a.id, sub.id, "pa", "five_hour_threshold", "A's alert", 95, 90);

    // B tries to ack A's alert by id.
    const ack = await req("POST", "/api/alerts/acknowledge", { headers: emailHdr("b@x.com"), body: { id: evt.id } });
    expect(ack.status).toBe(404);

    // Still unacknowledged for A.
    const stillUnacked = getTriggeredAlerts(a.id, "pa", 24, true);
    expect(stillUnacked.map((e) => e.id)).toContain(evt.id);
  });

  it("account B cannot read account A's alerts", async () => {
    const a = resolveAccount("a@x.com");
    resolveAccount("b@x.com");
    addProfile("pa", "/tmp/pa", 5, "anthropic-oauth", null, null, a.id);
    const sub = createAlertSubscription(a.id, "pa", "five_hour_threshold", 90, null, 30);
    createAlertEvent(a.id, sub.id, "pa", "five_hour_threshold", "secret", 95, 90);

    const aView = await req("GET", "/api/alerts?hours=24", { headers: emailHdr("a@x.com") });
    expect(aView.json.length).toBe(1);
    const bView = await req("GET", "/api/alerts?hours=24", { headers: emailHdr("b@x.com") });
    expect(bView.json.length).toBe(0);
  });
});

// ── H2/L4 — profile isolation ────────────────────────────────────────────────

describe("H2/L4 — profile/inventory isolation", () => {
  it("account B cannot see account A's profiles via /api/profiles", async () => {
    const a = resolveAccount("a@x.com");
    const b = resolveAccount("b@x.com");
    addProfile("a-only", "/tmp/a", 5, "anthropic-oauth", null, null, a.id);
    addProfile("b-only", "/tmp/b", 5, "anthropic-oauth", null, null, b.id);

    const aView = await req("GET", "/api/profiles", { headers: emailHdr("a@x.com") });
    expect(aView.json.map((p: any) => p.name)).toEqual(["a-only"]);
    const bView = await req("GET", "/api/profiles", { headers: emailHdr("b@x.com") });
    expect(bView.json.map((p: any) => p.name)).toEqual(["b-only"]);
  });

  it("account B cannot see account A's profiles via /api/usage", async () => {
    const a = resolveAccount("a@x.com");
    const b = resolveAccount("b@x.com");
    addProfile("a-only", "/tmp/a", 5, "anthropic-oauth", null, null, a.id);
    addProfile("b-only", "/tmp/b", 5, "anthropic-oauth", null, null, b.id);

    const aUsage = await req("GET", "/api/usage", { headers: emailHdr("a@x.com") });
    expect(aUsage.json.map((u: any) => u.profile)).toEqual(["a-only"]);
    const bUsage = await req("GET", "/api/usage", { headers: emailHdr("b@x.com") });
    expect(bUsage.json.map((u: any) => u.profile)).toEqual(["b-only"]);
  });
});

// ── H4 — header trust boundary ───────────────────────────────────────────────

describe("H4 — trusted-proxy header boundary", () => {
  it("with proxy secret set, a request without the proxy header is 401", async () => {
    process.env.CLAUDE_PULSE_TRUSTED_PROXY_SECRET = "s3cret";
    const r = await req("GET", "/api/profiles", { headers: emailHdr("a@x.com") });
    expect(r.status).toBe(401);
  });

  it("with proxy secret + correct proxy header + email, scopes correctly", async () => {
    process.env.CLAUDE_PULSE_TRUSTED_PROXY_SECRET = "s3cret";
    const a = resolveAccount("a@x.com");
    addProfile("a-only", "/tmp/a", 5, "anthropic-oauth", null, null, a.id);
    const r = await req("GET", "/api/profiles", {
      headers: { "X-Pulse-Proxy-Auth": "s3cret", ...emailHdr("a@x.com") },
    });
    expect(r.status).toBe(200);
    expect(r.json.map((p: any) => p.name)).toEqual(["a-only"]);
  });

  it("a wrong proxy secret is 401", async () => {
    process.env.CLAUDE_PULSE_TRUSTED_PROXY_SECRET = "s3cret";
    const r = await req("GET", "/api/me", {
      headers: { "X-Pulse-Proxy-Auth": "wrong", ...emailHdr("a@x.com") },
    });
    expect(r.status).toBe(401);
  });

  it("without CLAUDE_PULSE_SINGLE_TENANT, a header-less request (with proxy secret) is 401, not silently local", async () => {
    process.env.CLAUDE_PULSE_TRUSTED_PROXY_SECRET = "s3cret";
    // Correct proxy secret, but no email and single-tenant not enabled.
    const r = await req("GET", "/api/me", { headers: { "X-Pulse-Proxy-Auth": "s3cret" } });
    expect(r.status).toBe(401);
  });

  it("with CLAUDE_PULSE_SINGLE_TENANT=1 + proxy secret, an email-less request serves the local account", async () => {
    process.env.CLAUDE_PULSE_TRUSTED_PROXY_SECRET = "s3cret";
    process.env.CLAUDE_PULSE_SINGLE_TENANT = "1";
    const r = await req("GET", "/api/me", { headers: { "X-Pulse-Proxy-Auth": "s3cret" } });
    expect(r.status).toBe(200);
    expect(r.json.account).toBe("local");
  });
});

// ── M2 — body cap ────────────────────────────────────────────────────────────

describe("M2 — request body cap", () => {
  it("rejects a browser-route body over the 256KB cap", async () => {
    const big = "x".repeat(300 * 1024);
    const r = await req("POST", "/api/subscriptions", {
      headers: emailHdr("a@x.com"),
      body: { profile: "p", alert_type: "auth_failure", pad: big },
    });
    expect(r.status).toBe(413);
  });
});

// ── M1 — ingest rate limit ───────────────────────────────────────────────────

describe("M1 — ingest throttle", () => {
  it("returns 429 once the per-token rate limit is exceeded", async () => {
    const a = resolveAccount("rl@x.com");
    const { plaintext } = mintIngestToken(a.id, "m1");
    const hdr = { Authorization: `Bearer ${plaintext}` };

    let saw429 = false;
    // Capacity is 60/min; fire 70 fast requests — at least one must be throttled.
    for (let i = 0; i < 70; i++) {
      const r = await req("POST", "/api/ingest", { headers: hdr, body: { rollups: [] } });
      if (r.status === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true);
  });
});

// ── N3 — esc() escaping ──────────────────────────────────────────────────────

describe("N3 — esc() HTML escaping", () => {
  it("escapes < > & \" and '", () => {
    expect(esc(`<script>alert("x")&'y'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;",
    );
  });
  it("renders null/undefined as empty string", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});
