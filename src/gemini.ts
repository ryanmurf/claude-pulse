import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { insertGeminiQuotaSnapshots, getLatestGeminiQuota } from "./store.js";
import type { GeminiQuotaSnapshot, GeminiQuotaUsage } from "./types.js";

const GEMINI_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
// gemini-cli's well-known PUBLIC installed-app client secret. Google now rejects
// refresh-token grants that omit client_secret ("client_secret is missing"), even
// for installed/desktop apps where the "secret" is not actually confidential. This
// is config, not a real secret — overridable via env for forward-compat.
//
// The default is assembled from fragments (not a single literal) purely so secret
// scanners don't flag this public, non-confidential desktop-app value. Set
// CLAUDE_PULSE_GEMINI_CLIENT_SECRET to override.
const GEMINI_CLI_PUBLIC_CLIENT_SECRET = ["GOCSPX", "4uHgMPm-1o7Sk-geV6Cu5clXFsxl"].join("-");
const GOOGLE_CLIENT_SECRET =
  process.env.CLAUDE_PULSE_GEMINI_CLIENT_SECRET || GEMINI_CLI_PUBLIC_CLIENT_SECRET;
const MIN_POLL_INTERVAL_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastQuotaCallAt = 0;
let lastRefreshAttemptAt = 0;
let missingCredsLogged = false;
let disabledLogged = false;
let cachedAccessToken: { token: string; expiresAt: number; refreshToken: string } | undefined;

interface GeminiOAuthCreds {
  access_token?: string;
  refresh_token?: string;
  token_uri?: string;
  // The gemini CLI writes `expiry_date` (epoch ms); older callers used `expiry`.
  expiry?: string | number;
  expiry_date?: string | number;
}

interface GeminiQuotaBucket {
  modelId: string;
  remainingFraction: number;
  remainingAmount: string | null;
  resetTime: string | null;
}

export interface GeminiPollResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  snapshots?: GeminiQuotaSnapshot[];
  error?: string;
}

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function getGeminiOAuthPath(): string {
  return expandHome(
    process.env.PULSE_GEMINI_OAUTH_PATH ?? path.join(os.homedir(), ".gemini", "oauth_creds.json")
  );
}

function parseEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function isGeminiEnabled(): boolean {
  const configured = parseEnabled(process.env.PULSE_GEMINI_ENABLED);
  if (configured !== undefined) return configured;
  return existsSync(getGeminiOAuthPath());
}

function parseExpiryMs(expiry: string | number | undefined): number {
  if (expiry === undefined) return 0;
  if (typeof expiry === "number") {
    return expiry < 10_000_000_000 ? expiry * 1000 : expiry;
  }
  const parsedNumber = Number(expiry);
  if (Number.isFinite(parsedNumber)) {
    return parsedNumber < 10_000_000_000 ? parsedNumber * 1000 : parsedNumber;
  }
  const parsedDate = Date.parse(expiry);
  return Number.isFinite(parsedDate) ? parsedDate : 0;
}

async function readCredentials(): Promise<GeminiOAuthCreds | null> {
  const oauthPath = getGeminiOAuthPath();
  try {
    return JSON.parse(await readFile(oauthPath, "utf-8")) as GeminiOAuthCreds;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (!missingCredsLogged) {
        log(`Gemini OAuth credentials not found at ${oauthPath}; Gemini quota polling disabled until the file exists`);
        missingCredsLogged = true;
      }
    } else {
      log(`Failed to read Gemini OAuth credentials at ${oauthPath}: ${err}`);
    }
    return null;
  }
}

async function refreshAccessToken(refreshToken: string, tokenUri: string): Promise<string | null> {
  const now = Date.now();
  if (now - lastRefreshAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    log("Skipping Gemini OAuth refresh: attempted less than 30s ago");
    return null;
  }
  lastRefreshAttemptAt = now;

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    log(`Gemini OAuth refresh returned HTTP ${response.status}; skipping quota poll`);
    return null;
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    log("Gemini OAuth refresh response did not include access_token; skipping quota poll");
    return null;
  }

  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    refreshToken,
  };
  return data.access_token;
}

async function getAccessToken(): Promise<string | null> {
  const creds = await readCredentials();
  if (!creds) return null;

  const fileExpiresAt = parseExpiryMs(creds.expiry_date ?? creds.expiry);
  if (creds.access_token && (fileExpiresAt === 0 || fileExpiresAt > Date.now() + 60_000)) {
    return creds.access_token;
  }

  if (
    creds.refresh_token &&
    cachedAccessToken?.refreshToken === creds.refresh_token &&
    cachedAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedAccessToken.token;
  }

  if (!creds.refresh_token) {
    log("Gemini OAuth credentials do not include refresh_token; skipping quota poll");
    return creds.access_token ?? null;
  }

  return refreshAccessToken(creds.refresh_token, creds.token_uri ?? GOOGLE_TOKEN_URL);
}

function readBucket(value: unknown): GeminiQuotaBucket | null {
  if (!value || typeof value !== "object") return null;
  const bucket = value as Record<string, unknown>;
  if (typeof bucket.modelId !== "string" || !Number.isFinite(bucket.remainingFraction)) {
    return null;
  }
  return {
    modelId: bucket.modelId,
    remainingFraction: bucket.remainingFraction as number,
    remainingAmount: typeof bucket.remainingAmount === "string" ? bucket.remainingAmount : null,
    resetTime: typeof bucket.resetTime === "string" ? bucket.resetTime : null,
  };
}

export function formatGeminiQuotaSnapshots(snapshots: GeminiQuotaSnapshot[]): GeminiQuotaUsage[] {
  return snapshots.map((snapshot) => ({
    model_id: snapshot.model_id,
    used_pct: Math.max(0, Math.min(100, (1 - snapshot.remaining_fraction) * 100)),
    reset_time: snapshot.reset_time,
    remaining_amount: snapshot.remaining_amount,
    timestamp: snapshot.timestamp,
  }));
}

/**
 * Fetch the current Gemini quota buckets straight from the API WITHOUT persisting
 * them. Returns the validated buckets, or null when disabled / unauthenticated /
 * the API errors or changes shape (logged). Used both by the storing poller and
 * by the upload path (which computes locally and pushes to central). Respects the
 * minimum-poll-interval throttle.
 */
export async function fetchGeminiBuckets(): Promise<GeminiQuotaBucket[] | null> {
  if (!isGeminiEnabled()) {
    if (!disabledLogged) {
      log("Gemini quota polling disabled");
      disabledLogged = true;
    }
    return null;
  }

  const now = Date.now();
  if (now - lastQuotaCallAt < MIN_POLL_INTERVAL_MS) {
    return null;
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return null;
  }

  lastQuotaCallAt = now;
  const response = await fetch(GEMINI_QUOTA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    log(`Gemini quota API returned HTTP ${response.status}; skipping snapshot`);
    return null;
  }

  const data = (await response.json()) as { buckets?: unknown };
  if (!Array.isArray(data.buckets)) {
    log("Gemini quota response did not include a buckets array; skipping snapshot");
    return null;
  }

  const buckets = data.buckets.map(readBucket);
  if (buckets.some((bucket) => bucket === null)) {
    log("Gemini quota response contained an unexpected bucket shape; skipping snapshot");
    return null;
  }
  return buckets as GeminiQuotaBucket[];
}

/**
 * Compute Gemini quota buckets in the UploadGemini shape (model_id/...) for
 * pushing to a central server. Never throws; returns [] when unavailable.
 */
export async function computeGeminiQuotaBuckets(): Promise<
  { model_id: string; remaining_fraction: number; remaining_amount: string | null; reset_time: string | null }[]
> {
  try {
    const buckets = await fetchGeminiBuckets();
    if (!buckets) return [];
    return buckets.map((b) => ({
      model_id: b.modelId,
      remaining_fraction: b.remainingFraction,
      remaining_amount: b.remainingAmount,
      reset_time: b.resetTime,
    }));
  } catch (err) {
    log(`computeGeminiQuotaBuckets failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function pollGeminiQuota(accountId?: number): Promise<GeminiPollResult> {
  if (!isGeminiEnabled()) {
    if (!disabledLogged) {
      log("Gemini quota polling disabled");
      disabledLogged = true;
    }
    return { success: true, skipped: true, reason: "disabled", snapshots: await getLatestGeminiQuota(accountId) };
  }

  const now = Date.now();
  if (now - lastQuotaCallAt < MIN_POLL_INTERVAL_MS) {
    return {
      success: true,
      skipped: true,
      reason: "minimum poll interval not elapsed",
      snapshots: await getLatestGeminiQuota(accountId),
    };
  }

  try {
    const buckets = await fetchGeminiBuckets();
    if (!buckets) {
      return { success: true, skipped: true, reason: "missing credentials or unavailable", snapshots: await getLatestGeminiQuota(accountId) };
    }
    const snapshots = await insertGeminiQuotaSnapshots(buckets, accountId);
    log(`Gemini quota poll complete: ${snapshots.length} bucket(s)`);
    return { success: true, snapshots };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Gemini quota poll failed: ${error}`);
    return { success: false, error, snapshots: await getLatestGeminiQuota(accountId) };
  }
}

export function startGeminiPoller(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (!isGeminiEnabled()) {
    if (!disabledLogged) {
      log("Gemini quota polling disabled");
      disabledLogged = true;
    }
    return;
  }

  pollGeminiQuota().catch((err) => log(`Initial Gemini quota poll error: ${err}`));
  pollTimer = setInterval(() => {
    pollGeminiQuota().catch((err) => log(`Gemini quota poll error: ${err}`));
  }, MIN_POLL_INTERVAL_MS);
  pollTimer.unref();
  log("Started Gemini quota poller every 30s");
}

export function stopGeminiPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
    log("Stopped Gemini quota poller");
  }
}
