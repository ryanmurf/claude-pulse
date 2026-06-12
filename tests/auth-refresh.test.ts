import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOAuthTokens, _clearRefreshedTokenCache, ANTHROPIC_OAUTH_CLIENT_ID } from "../src/auth.js";
import { fetchUsage } from "../src/usage.js";

const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

let tmpDir: string;

function writeCreds(opts: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: number;
  scopes?: string[];
}): string {
  const creds = {
    claudeAiOauth: {
      accessToken: opts.accessToken ?? "old-access-token",
      refreshToken: opts.refreshToken === null ? undefined : (opts.refreshToken ?? "the-refresh-token"),
      expiresAt: opts.expiresAt ?? Date.now() - 60 * 60 * 1000, // expired 1h ago by default
      scopes: opts.scopes ?? ["user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default",
    },
  };
  const file = path.join(tmpDir, ".credentials.json");
  fs.writeFileSync(file, JSON.stringify(creds));
  return file;
}

function tokenResponse(accessToken: string, expiresIn = 3600, refreshToken?: string): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      expires_in: expiresIn,
      token_type: "Bearer",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-auth-test-"));
  _clearRefreshedTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getOAuthTokens — in-memory refresh for idle profiles", () => {
  it("refreshes an expired token via the standard Anthropic OAuth grant, in memory only", async () => {
    const credsFile = writeCreds({});
    const before = fs.readFileSync(credsFile, "utf8");

    const mock = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(TOKEN_ENDPOINT);
      const body = JSON.parse(String(init?.body));
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("the-refresh-token");
      expect(body.client_id).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
      return tokenResponse("fresh-access-token");
    });
    vi.stubGlobal("fetch", mock);

    const tokens = await getOAuthTokens(tmpDir);
    expect(tokens?.accessToken).toBe("fresh-access-token");
    expect(tokens!.expiresAt).toBeGreaterThan(Date.now());
    // Claude Code owns the credentials file — it must never be written.
    expect(fs.readFileSync(credsFile, "utf8")).toBe(before);
  });

  it("caches the refreshed token per profile until its expiry (single refresh call)", async () => {
    writeCreds({});
    const mock = vi.fn().mockResolvedValue(tokenResponse("fresh-access-token"));
    vi.stubGlobal("fetch", mock);

    const first = await getOAuthTokens(tmpDir);
    const second = await getOAuthTokens(tmpDir);
    expect(first?.accessToken).toBe("fresh-access-token");
    expect(second?.accessToken).toBe("fresh-access-token");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stored (expired) token when the refresh fails", async () => {
    writeCreds({});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 400 })));

    const tokens = await getOAuthTokens(tmpDir);
    // Prior behavior preserved: expired token returned, request attempted anyway.
    expect(tokens?.accessToken).toBe("old-access-token");
  });

  it("falls back to the stored token when there is no refresh token", async () => {
    writeCreds({ refreshToken: null });
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);

    const tokens = await getOAuthTokens(tmpDir);
    expect(tokens?.accessToken).toBe("old-access-token");
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not refresh when the stored token is still valid (Claude Code owns it)", async () => {
    writeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 });
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);

    const tokens = await getOAuthTokens(tmpDir);
    expect(tokens?.accessToken).toBe("old-access-token");
    expect(mock).not.toHaveBeenCalled();
  });

  it("prefers a NEWLY refreshed file token over a stale in-memory cache entry", async () => {
    // 1) Expired file token → in-memory refresh happens and is cached.
    writeCreds({});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse("in-memory-token")));
    expect((await getOAuthTokens(tmpDir))?.accessToken).toBe("in-memory-token");

    // 2) Claude Code rewrites the credentials file with a CURRENT token — the
    //    file wins and the cache entry is dropped.
    writeCreds({ accessToken: "cli-refreshed-token", expiresAt: Date.now() + 60 * 60 * 1000 });
    const tokens = await getOAuthTokens(tmpDir);
    expect(tokens?.accessToken).toBe("cli-refreshed-token");
  });

  it("rotates the refresh token in memory when the grant returns a new one", async () => {
    writeCreds({});
    const mock = vi
      .fn()
      // First refresh: short-lived token + rotated refresh token.
      .mockResolvedValueOnce(tokenResponse("short-lived", 30, "rotated-refresh-token"))
      // Second refresh must present the ROTATED token.
      .mockImplementationOnce(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.refresh_token).toBe("rotated-refresh-token");
        return tokenResponse("second-fresh-token");
      });
    vi.stubGlobal("fetch", mock);

    // expires_in=30s is within the expiry skew, so the next call refreshes again.
    expect((await getOAuthTokens(tmpDir))?.accessToken).toBe("short-lived");
    expect((await getOAuthTokens(tmpDir))?.accessToken).toBe("second-fresh-token");
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchUsage — 401-rejected token triggers in-memory refresh + one retry", () => {
  it("recovers a poll whose access token the API rejects despite an unexpired file", async () => {
    // File claims the token is valid for another hour, but the API 401s it
    // (revocation / clock skew — the idle-profile incident shape).
    writeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 });

    const usageBody = JSON.stringify({
      five_hour: { utilization: 33, resets_at: "2026-06-12T10:00:00Z" },
      seven_day: { utilization: 44, resets_at: "2026-06-15T00:00:00Z" },
    });

    const mock = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === TOKEN_ENDPOINT) return tokenResponse("fresh-access-token");
      if (u === USAGE_ENDPOINT) {
        const auth = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
        if (auth === "Bearer fresh-access-token") {
          return new Response(usageBody, { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("unauthorized", { status: 401 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", mock);

    const usage = await fetchUsage(tmpDir);
    expect(usage.fiveHourPct).toBe(33);
    expect(usage.sevenDayPct).toBe(44);
    // 401 → token refresh → retried usage call.
    const urls = mock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u === USAGE_ENDPOINT).length).toBe(2);
    expect(urls.filter((u) => u === TOKEN_ENDPOINT).length).toBe(1);
  });

  it("does not loop on persistent 401 (refresh once, then fail like before)", async () => {
    writeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 });

    const mock = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u === TOKEN_ENDPOINT) return tokenResponse("fresh-access-token");
      return new Response("unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", mock);

    await expect(fetchUsage(tmpDir)).rejects.toThrow(/401/);
    const urls = mock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u === USAGE_ENDPOINT).length).toBe(2); // original + single retry
    expect(urls.filter((u) => u === TOKEN_ENDPOINT).length).toBe(1);
  });
});
