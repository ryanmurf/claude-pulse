import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, unlink, open, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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
 * Keychain coordinates for a config dir. Claude Code stores credentials under
 * service "Claude Code-credentials-{sha256(configDir)[:8]}", account = username.
 */
function macKeychainCoords(configDir: string): { service: string; account: string } {
  return {
    service: `Claude Code-credentials-${configDirHash(configDir)}`,
    account: os.userInfo().username,
  };
}

/**
 * Read the FULL credentials JSON object from the macOS Keychain (every key, not
 * just claudeAiOauth) so callers can rewrite it preserving siblings like
 * mcpOAuth. Returns null on any read failure.
 */
async function readMacKeychainRaw(configDir: string): Promise<KeychainCredentials | null> {
  if (process.platform !== "darwin") return null;
  const { service, account } = macKeychainCoords(configDir);
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-s", service, "-a", account, "-w",
    ]);
    return JSON.parse(stdout.trim()) as KeychainCredentials;
  } catch (err) {
    log(`Failed to read keychain for ${configDir} (service: ${service}): ${err}`);
    return null;
  }
}

/**
 * Update the macOS Keychain credentials item IN PLACE via
 * `security add-generic-password -U`. The item already trusts the `security`
 * binary (we read it the same way without a prompt), so an in-place update keeps
 * Claude Code's own reads working. Returns false on failure — callers keep the
 * in-memory token for this run. Never logs the secret: the execFile error
 * message echoes the full argv (which includes the password), so we surface only
 * the exit status.
 */
async function writeMacKeychain(configDir: string, creds: KeychainCredentials): Promise<boolean> {
  const { service, account } = macKeychainCoords(configDir);
  try {
    await execFileAsync("security", [
      "add-generic-password", "-U", "-s", service, "-a", account, "-w", JSON.stringify(creds),
    ]);
    return true;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    log(`Keychain write failed for ${configDir} (security exit ${code ?? "error"})`);
    return false;
  }
}

/**
 * Read OAuth credentials (claudeAiOauth) from the macOS Keychain.
 */
async function readFromMacKeychain(configDir: string): Promise<OAuthTokens | null> {
  const creds = await readMacKeychainRaw(configDir);
  if (!creds?.claudeAiOauth?.accessToken) {
    if (creds) log(`No OAuth tokens in keychain for ${configDir}`);
    return null;
  }
  return creds.claudeAiOauth;
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

// ── OAuth auto-refresh for idle profiles ─────────────────────────────────────
// Claude Code refreshes the credentials file only while a session is live; an
// idle profile's access token expires and every poll turns into a 401 — which
// once froze the claude-hd-max gauge for ~9.5h until something re-logged-in.
//
// We refresh THE SAME COOPERATIVE WAY concurrent Claude Code sessions share one
// profile: take the per-file lock FIRST, re-read the credentials under it, and
// only run the refresh_token grant if the on-disk access token is STILL expired.
// If a live session (or a sibling poller) refreshed while we waited for the lock,
// we ADOPT its token instead of running our own grant — so we never spend a
// refresh token that another process still holds. Anthropic rotates (single-use)
// refresh tokens, so an out-of-order grant invalidates the token a sleeping
// session cached in memory and 401s it into "run /login" on wake. Lock-first +
// re-read + recheck is exactly what avoids that. The granted token is written
// back atomically (temp file in the same dir + rename) under the same lock, so
// the fix survives process restarts (the */30 upload cron spawns a fresh process
// each run) and a live session reading the file picks up the new token. We only
// ever touch the three token fields and preserve every other key (mcpOAuth,
// scopes, subscriptionType, ...).
//
// On macOS the credentials live in the Keychain (not a JSON file). We apply the
// SAME cooperative refresh there — lock, re-read, adopt, grant-if-still-expired —
// and persist the rotated token back to the Keychain in place via
// `security add-generic-password -U` (the item already trusts the `security`
// binary, so Claude Code keeps reading it). See refreshUnderLockMac.

export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
/** Treat tokens expiring within this window as already expired (clock skew). */
const EXPIRY_SKEW_MS = 60_000;
/** Max time to wait for the per-file persist lock before giving up. */
const PERSIST_LOCK_TIMEOUT_MS = 5_000;

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Per-configDir cache of refreshed tokens (process lifetime fast-path). */
const refreshedTokenCache = new Map<string, RefreshedTokens>();

/** Test hook: clear the in-memory refreshed-token cache. */
export function _clearRefreshedTokenCache(): void {
  refreshedTokenCache.clear();
}

function isExpired(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt < now + EXPIRY_SKEW_MS;
}

function credentialsPath(configDir: string): string {
  return path.join(configDir, ".credentials.json");
}

/**
 * Acquire a best-effort cross-process lock on `<credsPath>.lock` via
 * O_CREAT|O_EXCL (the same exclusive-create primitive pidlock.ts relies on),
 * spinning briefly on contention. A stale lock (older than the timeout, e.g.
 * left by a crashed poller) is broken so a single dead process can't wedge
 * persistence forever. Returns a release fn, or null if the lock couldn't be
 * taken — callers then skip the write rather than risk a torn file.
 */
async function acquireCredsLock(credsPath: string): Promise<(() => Promise<void>) | null> {
  const lockPath = `${credsPath}.lock`;
  const deadline = Date.now() + PERSIST_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      await fh.write(`${process.pid}\n`);
      await fh.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          /* already removed */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Unexpected error (perms, ENOENT on dir, ...) — don't write.
        return null;
      }
      // Break a stale lock left by a dead/crashed holder.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > PERSIST_LOCK_TIMEOUT_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        /* vanished between EEXIST and stat — retry the create */
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/**
 * macOS cooperative refresh — mirrors the Linux file path but with the Keychain
 * as the credential store.
 *
 * Many claude-pulse instances poll the same profiles at once (each Claude Code
 * session spawns its own MCP server), so an UNCOORDINATED in-memory grant on
 * macOS had every instance spend the single-use refresh token while none wrote
 * the rotated token back — orphaning the token Claude Code still held in the
 * Keychain and 401'ing it into "run /login". We now take a per-config-dir lock,
 * re-read the Keychain under it, ADOPT a token a sibling/live session already
 * refreshed (never burning one another process holds), and only run the grant if
 * the Keychain token is STILL expired. The rotated token is written back to the
 * Keychain in place, preserving every other key, so Claude Code (which reads the
 * same item) never sees a spent refresh token.
 */
async function refreshUnderLockMac(
  configDir: string,
  fileTokens: OAuthTokens,
  force: boolean,
): Promise<RefreshedTokens | null> {
  // The Keychain isn't a lockable path; coordinate sibling pollers on a lock
  // file in the config dir (there is no .credentials.json on macOS to collide).
  const release = await acquireCredsLock(credentialsPath(configDir));
  if (!release) {
    log(`OAuth refresh skipped for ${configDir}: could not acquire keychain refresh lock (a sibling is refreshing)`);
    return null;
  }
  try {
    const creds = await readMacKeychainRaw(configDir);
    const onDisk = creds?.claudeAiOauth;
    if (!onDisk?.refreshToken) {
      log(`OAuth refresh skipped for ${configDir}: no refresh token in keychain`);
      return null;
    }
    // Adopt a token someone refreshed while we waited for the lock. Under `force`
    // (the API just 401'd despite an unexpired expiry) only adopt a DIFFERENT
    // token (a live session already replaced the bad one); never re-serve the dud.
    const adopt =
      !isExpired(onDisk.expiresAt) && (!force || onDisk.accessToken !== fileTokens.accessToken);
    if (adopt) {
      return {
        accessToken: onDisk.accessToken,
        refreshToken: onDisk.refreshToken,
        expiresAt: onDisk.expiresAt,
      };
    }

    // Still expired on disk: WE run the single refresh with the freshest
    // Keychain refresh token, then persist the rotated token back in place.
    const refreshed = await refreshAccessToken(configDir, onDisk.refreshToken);
    if (!refreshed) return null;

    const updated: KeychainCredentials = {
      ...creds,
      claudeAiOauth: {
        ...onDisk,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      },
    };
    if (await writeMacKeychain(configDir, updated)) {
      log(
        `OAuth token refreshed + persisted to keychain for ${configDir} (expires ${new Date(refreshed.expiresAt).toISOString()})`,
      );
    } else {
      log(`OAuth token refreshed for ${configDir} but keychain persist failed; in-memory only this run`);
    }
    return refreshed;
  } finally {
    await release();
  }
}

/**
 * Cooperative, lock-first refresh — the same pattern concurrent Claude Code
 * sessions use to share one profile's credentials.
 *
 * Take the creds lock FIRST, then re-read <configDir>/.credentials.json under it.
 * If the on-disk access token is already current (a live session or sibling
 * poller refreshed while we waited for the lock), ADOPT it and return without
 * running a grant — this is the key anti-logout move: we never spend a refresh
 * token another process may still hold. Only if it's STILL expired do we run the
 * standard Anthropic refresh_token grant, using the freshest on-disk refresh
 * token (not a possibly-stale in-memory one), then persist the rotated token
 * back atomically under the same lock (temp file + rename, 0600), preserving
 * every other key.
 *
 * Returns the tokens to use (freshly granted, or adopted from disk), or null if
 * we couldn't refresh — no lock (a live session is likely mid-refresh; better to
 * skip one poll than to race it) or the grant failed. Callers fall back to the
 * stored token, preserving the old "attempt anyway" behavior. Never logs token
 * values. On macOS the creds live in the Keychain (no file lock to coordinate
 * on), so we do the in-memory grant only and never write.
 */
async function refreshUnderLock(
  configDir: string,
  fileTokens: OAuthTokens,
  force: boolean,
): Promise<RefreshedTokens | null> {
  // macOS: Keychain-backed. Refresh cooperatively (lock + re-read + adopt) and
  // persist the rotated token back to the Keychain — see refreshUnderLockMac.
  if (process.platform === "darwin") {
    return refreshUnderLockMac(configDir, fileTokens, force);
  }

  const credsPath = credentialsPath(configDir);
  const release = await acquireCredsLock(credsPath);
  if (!release) {
    log(`OAuth refresh skipped for ${configDir}: could not acquire creds lock (a live session is likely refreshing)`);
    return null;
  }
  try {
    // Re-read under the lock — the on-disk file is the source of truth now.
    let creds: KeychainCredentials;
    try {
      creds = JSON.parse(await readFile(credsPath, "utf-8")) as KeychainCredentials;
    } catch (err) {
      log(`OAuth refresh skipped for ${configDir}: re-read failed (${(err as Error).message})`);
      return null;
    }
    const onDisk = creds.claudeAiOauth;
    if (!onDisk?.refreshToken) {
      log(`OAuth refresh skipped for ${configDir}: no refresh token on disk`);
      return null;
    }
    // Someone refreshed while we waited for the lock — adopt their token and do
    // NOT burn ours. This is what stops a sleeping session from being logged out.
    // Under `force` (the API just 401'd this token despite an unexpired expiry —
    // revocation/skew) we only adopt if the on-disk token is a DIFFERENT one
    // (i.e. a live session already replaced the bad token); if it's the same
    // rejected token, we must grant a new one rather than re-serve the dud.
    const adopt =
      !isExpired(onDisk.expiresAt) && (!force || onDisk.accessToken !== fileTokens.accessToken);
    if (adopt) {
      return {
        accessToken: onDisk.accessToken,
        refreshToken: onDisk.refreshToken,
        expiresAt: onDisk.expiresAt,
      };
    }

    // Still expired on disk: WE run the single refresh, with the freshest
    // on-disk refresh token.
    const refreshed = await refreshAccessToken(configDir, onDisk.refreshToken);
    if (!refreshed) return null;

    // Persist atomically under the lock we already hold. Atomic replace: write a
    // uniquely-named temp file in the SAME directory (rename is atomic only
    // within a filesystem), then rename over the original so a reader sees either
    // the old or the new file, never a torn write. 0600 keeps it owner-only.
    creds.claudeAiOauth = {
      ...onDisk,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    const tmpPath = `${credsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
      await rename(tmpPath, credsPath);
      log(
        `OAuth token refreshed + persisted for ${configDir} (expires ${new Date(refreshed.expiresAt).toISOString()})`,
      );
    } catch (err) {
      // We rotated at Anthropic but couldn't write — return the token anyway so
      // this poll works; the in-memory cache carries it. Rare I/O error path.
      log(`OAuth token persist failed for ${configDir}: ${(err as Error).message}`);
      await unlink(tmpPath).catch(() => {});
    }
    return refreshed;
  } finally {
    await release();
  }
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
 * rejected it — and a refresh token exists, the token is refreshed via the
 * standard Anthropic OAuth grant and PERSISTED back to the credential store
 * (the credentials file on Linux, the Keychain on macOS) so the fix survives
 * process restarts and is shared with any live Claude session. The refreshed token is also cached in
 * memory per profile until ITS expiry. Refresh failure falls back to the
 * stored token, preserving the old "attempt anyway" behavior — the poll loop
 * never crashes and other profiles are unaffected.
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

  // Refresh cooperatively under the creds lock: re-read first and adopt any
  // token a live session already wrote, so we never rotate one it still holds
  // in memory. The grant + atomic write-back both happen inside the lock.
  if (tokens.refreshToken) {
    const refreshed = await refreshUnderLock(configDir, tokens, force);
    if (refreshed) {
      refreshedTokenCache.set(configDir, refreshed);
      return {
        ...tokens,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
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
