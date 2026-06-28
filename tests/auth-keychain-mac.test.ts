import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Shared mock state, hoisted above vi.mock so the factory may reference it.
const kc = vi.hoisted(() => ({
  store: new Map<string, string>(), // "service||account" -> password JSON
  calls: [] as string[][],
  findCount: 0,
  mutateAfterFind: 0,
  mutation: null as null | (() => void),
  failAdd: false,
}));

// Mock the `security` CLI with an in-memory keychain.
vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    kc.calls.push([file, ...args]);
    if (file !== "security") return cb(new Error(`unexpected exec: ${file}`));
    const sub = args[0];
    const key = `${args[args.indexOf("-s") + 1]}||${args[args.indexOf("-a") + 1]}`;
    if (sub === "find-generic-password") {
      const v = kc.store.get(key);
      kc.findCount++;
      if (kc.mutation && kc.findCount === kc.mutateAfterFind) kc.mutation();
      if (v === undefined) return cb(new Error("The specified item could not be found in the keychain."));
      return cb(null, { stdout: v + "\n", stderr: "" });
    }
    if (sub === "add-generic-password") {
      if (kc.failAdd) return cb(new Error("Command failed: security add-generic-password ... -w <SECRET>"));
      kc.store.set(key, args[args.indexOf("-w") + 1]);
      return cb(null, { stdout: "", stderr: "" });
    }
    if (sub === "delete-generic-password") {
      kc.store.delete(key);
      return cb(null, { stdout: "", stderr: "" });
    }
    return cb(new Error(`unhandled security subcommand: ${sub}`));
  },
}));

// Imported AFTER vi.mock so auth.ts binds the mocked child_process.
const { getOAuthTokens, _clearRefreshedTokenCache } = await import("../src/auth.js");

let configDir: string;
let origPlatform: PropertyDescriptor | undefined;

function kcKey(dir: string): string {
  const service = `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
  return `${service}||${os.userInfo().username}`;
}
function seed(creds: unknown): void {
  kc.store.set(kcKey(configDir), JSON.stringify(creds));
}
function readKc(): any {
  const v = kc.store.get(kcKey(configDir));
  return v ? JSON.parse(v) : null;
}
function oauth(over: Record<string, unknown> = {}) {
  return {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: Date.now() - 60 * 60 * 1000, // expired 1h ago
    scopes: ["user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default",
    ...over,
  };
}
function grantResponse(accessToken: string, refreshToken?: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: accessToken, ...(refreshToken ? { refresh_token: refreshToken } : {}), expires_in: expiresIn }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-kc-"));
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  kc.store.clear();
  kc.calls = [];
  kc.findCount = 0;
  kc.mutateAfterFind = 0;
  kc.mutation = null;
  kc.failAdd = false;
  _clearRefreshedTokenCache();
});

afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  vi.unstubAllGlobals();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("macOS Keychain cooperative refresh", () => {
  it("refreshes an expired token and PERSISTS the rotated token back to the Keychain", async () => {
    seed({ claudeAiOauth: oauth(), mcpOAuth: { keep: "me" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(grantResponse("new-access", "new-refresh")));

    const tokens = await getOAuthTokens(configDir);

    expect(tokens?.accessToken).toBe("new-access");
    const stored = readKc();
    // The whole point: Claude Code reads the same item, so the rotated token
    // must be written back — not kept in pulse's memory only.
    expect(stored.claudeAiOauth.accessToken).toBe("new-access");
    expect(stored.claudeAiOauth.refreshToken).toBe("new-refresh");
    expect(stored.mcpOAuth).toEqual({ keep: "me" }); // sibling keys preserved
    expect(kc.calls.some((c) => c.includes("add-generic-password") && c.includes("-U"))).toBe(true);
  });

  it("keeps the old refresh token when the grant does not rotate it", async () => {
    seed({ claudeAiOauth: oauth() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(grantResponse("new-access"))); // no refresh_token in response

    await getOAuthTokens(configDir);

    expect(readKc().claudeAiOauth.refreshToken).toBe("old-refresh");
    expect(readKc().claudeAiOauth.accessToken).toBe("new-access");
  });

  it("ADOPTS a token a sibling wrote while we waited for the lock (no grant)", async () => {
    seed({ claudeAiOauth: oauth() }); // top-level read sees expired
    // After the first find (getOAuthTokens' read), a sibling refreshes the item.
    kc.mutateAfterFind = 1;
    kc.mutation = () =>
      seed({ claudeAiOauth: oauth({ accessToken: "sibling-access", refreshToken: "sibling-refresh", expiresAt: Date.now() + 60 * 60 * 1000 }) });
    const fetchMock = vi.fn(); // a grant here would double-spend the refresh token
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await getOAuthTokens(configDir);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokens?.accessToken).toBe("sibling-access");
    // We must NOT have written (the sibling owns the current token).
    expect(kc.calls.some((c) => c.includes("add-generic-password"))).toBe(false);
  });

  it("returns the granted token even if the Keychain write fails (no crash)", async () => {
    seed({ claudeAiOauth: oauth() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(grantResponse("new-access", "new-refresh")));
    kc.failAdd = true;

    const tokens = await getOAuthTokens(configDir);

    expect(tokens?.accessToken).toBe("new-access"); // in-memory fallback still serves the poll
    expect(readKc().claudeAiOauth.accessToken).toBe("old-access"); // keychain untouched on write failure
  });

  it("returns the stored token (no grant) when the Keychain has no refresh token", async () => {
    seed({ claudeAiOauth: oauth({ refreshToken: undefined }) });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await getOAuthTokens(configDir);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokens?.accessToken).toBe("old-access"); // falls back to the stored (expired) token
  });
});
