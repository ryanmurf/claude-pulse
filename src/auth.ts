import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

interface KeychainCredentials {
  claudeAiOauth?: OAuthTokens;
  [key: string]: unknown;
}

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

function configDirHash(configDir: string): string {
  return createHash("sha256").update(configDir).digest("hex").slice(0, 8);
}

/**
 * Read OAuth credentials from the macOS Keychain.
 * Claude Code stores credentials under service "Claude Code-credentials-{sha256(configDir)[:8]}".
 */
async function readFromMacKeychain(configDir: string): Promise<OAuthTokens | null> {
  if (process.platform !== "darwin") return null;

  const hash = configDirHash(configDir);
  const service = `Claude Code-credentials-${hash}`;
  const account = os.userInfo().username;

  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", service,
      "-a", account,
      "-w",
    ]);

    const creds: KeychainCredentials = JSON.parse(stdout.trim());
    if (!creds.claudeAiOauth?.accessToken) {
      log(`No OAuth tokens in keychain for ${configDir} (service: ${service})`);
      return null;
    }
    return creds.claudeAiOauth;
  } catch (err) {
    log(`Failed to read keychain for ${configDir} (service: ${service}): ${err}`);
    return null;
  }
}

/**
 * Read OAuth credentials from the Linux plain-JSON credentials file.
 * Claude Code on Linux stores credentials at `<configDir>/.credentials.json`.
 */
async function readFromLinuxCredentialsFile(configDir: string): Promise<OAuthTokens | null> {
  if (process.platform === "darwin") return null;

  const credsPath = path.join(configDir, ".credentials.json");
  try {
    const raw = await readFile(credsPath, "utf-8");
    const creds: KeychainCredentials = JSON.parse(raw);
    if (!creds.claudeAiOauth?.accessToken) {
      log(`No claudeAiOauth.accessToken in ${credsPath}`);
      return null;
    }
    return creds.claudeAiOauth;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log(`No credentials file at ${credsPath}`);
    } else {
      log(`Failed to read ${credsPath}: ${err}`);
    }
    return null;
  }
}

// ── In-memory OAuth refresh for idle profiles ────────────────────────────────
// Claude Code refreshes the credentials file only while a session is live; an
// idle profile's access token expires and every poll turns into a 401. When
// the file's token is expired and a refresh token exists, refresh IN MEMORY
// for this process only. The credentials file is owned by Claude Code and is
// NEVER written.

export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
/** Treat tokens expiring within this window as already expired (clock skew). */
const EXPIRY_SKEW_MS = 60_000;

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Per-configDir cache of in-memory-refreshed tokens (process lifetime). */
const refreshedTokenCache = new Map<string, RefreshedTokens>();

/** Test hook: clear the in-memory refreshed-token cache. */
export function _clearRefreshedTokenCache(): void {
  refreshedTokenCache.clear();
}

function isExpired(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt < now + EXPIRY_SKEW_MS;
}

/**
 * Standard Anthropic OAuth refresh_token grant. Returns null on any failure —
 * callers fall back to the (expired) file token, preserving prior behavior.
 * Never logs token values.
 */
async function refreshAccessToken(
  configDir: string,
  refreshToken: string,
): Promise<RefreshedTokens | null> {
  try {
    const response = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      log(`OAuth refresh failed for ${configDir}: HTTP ${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof data.access_token !== "string" || data.access_token.length === 0) {
      log(`OAuth refresh failed for ${configDir}: no access_token in response`);
      return null;
    }
    const expiresInSec = Number(data.expires_in);
    const expiresAt =
      Date.now() + (Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : 3_600_000);
    return {
      accessToken: data.access_token,
      // The grant may rotate the refresh token; keep the newest one in memory
      // so subsequent refreshes keep working.
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : refreshToken,
      expiresAt,
    };
  } catch (err) {
    log(`OAuth refresh error for ${configDir}: ${err}`);
    return null;
  }
}

/**
 * Get OAuth tokens for a config dir.
 *
 * Reads the credential source fresh each time (keychain on macOS, plain JSON
 * on Linux). When the stored access token is current it's returned as-is and
 * any in-memory refresh state is dropped (Claude Code refreshed it for us).
 * When it's expired — or `opts.forceRefresh` is set because the API just
 * rejected it — and a refresh token exists, the token is refreshed in memory
 * for this poll (cached per profile until ITS expiry). Refresh failure falls
 * back to the stored token, preserving the old "attempt anyway" behavior.
 */
export async function getOAuthTokens(
  configDir: string,
  opts?: { forceRefresh?: boolean },
): Promise<OAuthTokens | null> {
  const tokens =
    process.platform === "darwin"
      ? await readFromMacKeychain(configDir)
      : await readFromLinuxCredentialsFile(configDir);
  if (!tokens) return null;

  const force = opts?.forceRefresh === true;
  if (!isExpired(tokens.expiresAt) && !force) {
    // File token is current — Claude Code is refreshing it; ours is obsolete.
    refreshedTokenCache.delete(configDir);
    return tokens;
  }

  // Serve from the in-memory cache while OUR refreshed token is still valid
  // (unless the caller just saw it rejected and demands a fresh one).
  const cached = refreshedTokenCache.get(configDir);
  if (!force && cached && !isExpired(cached.expiresAt)) {
    return { ...tokens, accessToken: cached.accessToken, expiresAt: cached.expiresAt };
  }

  // Prefer the newest known refresh token (rotation), else the file's.
  const refreshTokenToUse = cached?.refreshToken || tokens.refreshToken;
  if (refreshTokenToUse) {
    const refreshed = await refreshAccessToken(configDir, refreshTokenToUse);
    if (refreshed) {
      refreshedTokenCache.set(configDir, refreshed);
      log(
        `OAuth token refreshed in-memory for ${configDir} (expires ${new Date(refreshed.expiresAt).toISOString()}); credentials file untouched`,
      );
      return { ...tokens, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    }
  }

  if (isExpired(tokens.expiresAt)) {
    log(`OAuth token expired for ${configDir} (expired ${new Date(tokens.expiresAt).toISOString()}), will attempt request anyway`);
  }

  return tokens;
}

export function hasProfileScope(tokens: OAuthTokens): boolean {
  return tokens.scopes?.includes("user:profile") ?? false;
}

export function hasInferenceScope(tokens: OAuthTokens): boolean {
  return tokens.scopes?.includes("user:inference") ?? false;
}
