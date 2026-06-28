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

let origPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-auth-test-"));
  // These exercise the Linux file-based credentials path; pin the platform so
  // they're deterministic on macOS too (where the real code reads the Keychain,
  // covered separately in auth-keychain-mac.test.ts).
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  _clearRefreshedTokenCache();
});

afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getOAuthTokens — auto-refresh + atomic persist for idle profiles", () => {
  it("refreshes an expired token via the standard Anthropic OAuth grant and persists it", async () => {
    const credsFile = writeCreds({});

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

    // The refreshed token is persisted back to the credentials file so it
    // survives process restarts and is shared with live sessions.
    const persisted = JSON.parse(fs.readFileSync(credsFile, "utf8"));
    expect(persisted.claudeAiOauth.accessToken).toBe("fresh-access-token");
    expect(persisted.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
    // Sibling fields are preserved untouched.
    expect(persisted.claudeAiOauth.scopes).toEqual(["user:profile"]);
    expect(persisted.claudeAiOauth.subscriptionType).toBe("max");
    expect(persisted.claudeAiOauth.refreshToken).toBe("the-refresh-token");
    // No temp/lock files leaked.
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
    expect(leftovers).toEqual([]);
  });

  it("preserves unrelated top-level keys (e.g. mcpOAuth) when persisting", async () => {
    const credsFile = path.join(tmpDir, ".credentials.json");
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        mcpOAuth: { some: "value", nested: { keep: true } },
        claudeAiOauth: {
          accessToken: "old-access-token",
          refreshToken: "the-refresh-token",
          expiresAt: Date.now() - 60 * 60 * 1000,
          scopes: ["user:profile"],
          subscriptionType: "max",
          rateLimitTier: "default",
        },
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse("fresh-access-token")));

    await getOAuthTokens(tmpDir);

    const persisted = JSON.parse(fs.readFileSync(credsFile, "utf8"));
    expect(persisted.mcpOAuth).toEqual({ some: "value", nested: { keep: true } });
    expect(persisted.claudeAiOauth.accessToken).toBe("fresh-access-token");
  });

  it("persists a rotated refresh token so the next process restart can refresh again", async () => {
    const credsFile = writeCreds({});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(tokenResponse("fresh-access-token", 3600, "rotated-refresh-token")),
    );

    await getOAuthTokens(tmpDir);

    const persisted = JSON.parse(fs.readFileSync(credsFile, "utf8"));
    expect(persisted.claudeAiOauth.refreshToken).toBe("rotated-refresh-token");
    expect(persisted.claudeAiOauth.accessToken).toBe("fresh-access-token");
  });

  it("does not corrupt the file or crash when a stale lock is present (breaks it)", async () => {
    const credsFile = writeCreds({});
    // Simulate a crashed poller's leftover lock with an old mtime.
    const lockPath = `${credsFile}.lock`;
    fs.writeFileSync(lockPath, "99999\n");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse("fresh-access-token")));

    const tokens = await getOAuthTokens(tmpDir);
    expect(tokens?.accessToken).toBe("fresh-access-token");
    const persisted = JSON.parse(fs.readFileSync(credsFile, "utf8"));
    expect(persisted.claudeAiOauth.accessToken).toBe("fresh-access-token");
    // The stale lock was broken and released.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("adopts a token a concurrent session wrote while we waited for the lock — never burns it", async () => {
    // Anti-logout guarantee: our in-memory token is expired, but by the time we
    // get the creds lock a live Claude session has refreshed the file. We must
    // ADOPT that on-disk token and run NO grant of our own — running one would
    // rotate (single-use) the refresh token the live session still holds and
    // 401 it into "run /login". Simulate the live session by holding the lock,
    // then writing a fresh token + releasing it mid-call.
    const credsFile = writeCreds({ accessToken: "expired-tok", refreshToken: "rt0" }); // expired
    const lockPath = `${credsFile}.lock`;
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" }); // "live session" holds it

    const fetchMock = vi.fn(); // a token grant here would be the bug
    vi.stubGlobal("fetch", fetchMock);

    // The "live session" finishes its refresh: writes a current token, releases.
    setTimeout(() => {
      fs.writeFileSync(
        credsFile,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "cli-fresh",
            refreshToken: "rt1",
            expiresAt: Date.now() + 60 * 60 * 1000,
            scopes: ["user:profile"],
            subscriptionType: "max",
            rateLimitTier: "default",
          },
        }),
      );
      fs.rmSync(lockPath, { force: true });
    }, 150);

    const tokens = await getOAuthTokens(tmpDir);
    expect(tokens?.accessToken).toBe("cli-fresh"); // adopted the sibling's token
    expect(fetchMock).not.toHaveBeenCalled(); // never ran a grant → never burned rt1
    // The on-disk token (and the sibling's refresh token) is untouched.
    const after = JSON.parse(fs.readFileSync(credsFile, "utf8"));
    expect(after.claudeAiOauth.refreshToken).toBe("rt1");
    // No temp/lock files leaked.
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
    expect(leftovers).toEqual([]);
  });

  it("never leaves the credentials file as invalid JSON (atomic replace)", async () => {
    const credsFile = writeCreds({});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse("fresh-access-token")));

    await getOAuthTokens(tmpDir);

    // File is always parseable — the temp-file-then-rename keeps it intact.
    expect(() => JSON.parse(fs.readFileSync(credsFile, "utf8"))).not.toThrow();
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
