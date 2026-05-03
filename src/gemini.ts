import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { insertGeminiQuotaSnapshots, getLatestGeminiQuota } from "./store.js";
import type { GeminiQuotaSnapshot, GeminiQuotaUsage } from "./types.js";

const GEMINI_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
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
  expiry?: string | number;
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

  const fileExpiresAt = parseExpiryMs(creds.expiry);
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

export async function pollGeminiQuota(): Promise<GeminiPollResult> {
  if (!isGeminiEnabled()) {
    if (!disabledLogged) {
      log("Gemini quota polling disabled");
      disabledLogged = true;
    }
    return { success: true, skipped: true, reason: "disabled", snapshots: getLatestGeminiQuota() };
  }

  const now = Date.now();
  if (now - lastQuotaCallAt < MIN_POLL_INTERVAL_MS) {
    return {
      success: true,
      skipped: true,
      reason: "minimum poll interval not elapsed",
      snapshots: getLatestGeminiQuota(),
    };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: true, skipped: true, reason: "missing credentials", snapshots: getLatestGeminiQuota() };
  }

  lastQuotaCallAt = now;
  try {
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
      const error = `Gemini quota API returned HTTP ${response.status}`;
      log(`${error}; skipping snapshot`);
      return { success: false, error, snapshots: getLatestGeminiQuota() };
    }

    const data = (await response.json()) as { buckets?: unknown };
    if (!Array.isArray(data.buckets)) {
      log("Gemini quota response did not include a buckets array; skipping snapshot");
      return { success: false, error: "Gemini quota response shape changed", snapshots: getLatestGeminiQuota() };
    }

    const buckets = data.buckets.map(readBucket);
    if (buckets.some((bucket) => bucket === null)) {
      log("Gemini quota response contained an unexpected bucket shape; skipping snapshot");
      return { success: false, error: "Gemini quota bucket shape changed", snapshots: getLatestGeminiQuota() };
    }

    const snapshots = insertGeminiQuotaSnapshots(buckets as GeminiQuotaBucket[]);
    log(`Gemini quota poll complete: ${snapshots.length} bucket(s)`);
    return { success: true, snapshots };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Gemini quota poll failed: ${error}`);
    return { success: false, error, snapshots: getLatestGeminiQuota() };
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
