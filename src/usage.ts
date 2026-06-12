import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Dirent } from "node:fs";
import { getOAuthTokens, hasProfileScope, hasInferenceScope } from "./auth.js";
import type { OAuthTokens } from "./auth.js";
import type { Profile, ProfileVendor } from "./types.js";

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

/**
 * First UTC instant of the next calendar month — used as the synthetic
 * "reset" time for monthly-budget vendors so dashboards/alerts can show
 * a countdown without inventing a separate field.
 */
function firstOfNextMonthUtc(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return new Date(Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1, 0, 0, 0, 0)).toISOString();
}

export interface UsageData {
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  raw: string;
}

// ── Option A: /api/oauth/usage endpoint (zero quota cost) ───────────────────

interface UsageApiRateLimit {
  utilization: number | null;
  resets_at: string | null;
}

interface UsageApiResponse {
  five_hour?: UsageApiRateLimit | null;
  seven_day?: UsageApiRateLimit | null;
  [key: string]: unknown;
}

/**
 * Normalize an ISO timestamp to whole seconds. Anthropic's /api/oauth/usage
 * returns quantized reset times whose sub-second part is per-request noise
 * (e.g. 04:40:00.714116Z vs 04:40:00.000Z for the same window) — truncating
 * at the reader keeps pushed snapshot content stable across polls. The
 * central ingest regression guard keeps its jitter tolerance as
 * defense-in-depth for not-yet-upgraded reporters.
 */
export function truncateIsoToSeconds(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/** Transient statuses worth retrying within a single poll: 429 + 5xx. */
function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Backoff schedule for in-poll retries (exponential-ish + jitter added at use). */
const USAGE_API_RETRY_DELAYS_MS = [2_000, 5_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exported for tests (mocked global fetch). `retryDelaysMs` overrides the
 * backoff schedule so tests don't sleep for real.
 */
export async function fetchViaUsageApi(
  tokens: OAuthTokens,
  opts?: { retryDelaysMs?: number[] },
): Promise<UsageData> {
  const delays = opts?.retryDelaysMs ?? USAGE_API_RETRY_DELAYS_MS;

  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "Authorization": `Bearer ${tokens.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    // Retry 429/5xx a couple of times within this poll so a brief throttle
    // burst doesn't turn the whole cycle into a pushed-nothing failure.
    // Persistent 429 still falls through to the throw below.
    if (response.ok || attempt >= delays.length || !isRetryableHttpStatus(response.status)) {
      break;
    }
    const delay = delays[attempt] + Math.floor(Math.random() * 1_000);
    log(
      `Usage API returned ${response.status}; retrying in ${delay}ms (attempt ${attempt + 1}/${delays.length})`,
    );
    // Drain the body so the failed response doesn't hold its socket open.
    await response.text().catch(() => undefined);
    await sleep(delay);
  }

  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}: ${await response.text()}`);
  }

  const data: UsageApiResponse = await response.json() as UsageApiResponse;
  const raw = JSON.stringify(data);

  return {
    fiveHourPct: data.five_hour?.utilization ?? null,
    fiveHourResetsAt: truncateIsoToSeconds(data.five_hour?.resets_at ?? null),
    sevenDayPct: data.seven_day?.utilization ?? null,
    sevenDayResetsAt: truncateIsoToSeconds(data.seven_day?.resets_at ?? null),
    raw,
  };
}

// ── Option B: Minimal API call + rate limit headers ─────────────────────────

async function fetchViaHeaders(tokens: OAuthTokens): Promise<UsageData> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokens.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "ok" }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const headers = response.headers;
  const body = await response.text();

  // Utilization headers are 0-1 fractions; convert to percentage
  const fiveHourUtil = headers.get("anthropic-ratelimit-unified-5h-utilization");
  const fiveHourReset = headers.get("anthropic-ratelimit-unified-5h-reset");
  const sevenDayUtil = headers.get("anthropic-ratelimit-unified-7d-utilization");
  const sevenDayReset = headers.get("anthropic-ratelimit-unified-7d-reset");

  const fiveHourPct = fiveHourUtil !== null ? Number(fiveHourUtil) * 100 : null;
  const sevenDayPct = sevenDayUtil !== null ? Number(sevenDayUtil) * 100 : null;

  // Reset headers are unix epoch seconds
  const fiveHourResetsAt = fiveHourReset !== null
    ? new Date(Number(fiveHourReset) * 1000).toISOString()
    : null;
  const sevenDayResetsAt = sevenDayReset !== null
    ? new Date(Number(sevenDayReset) * 1000).toISOString()
    : null;

  if (fiveHourPct === null && sevenDayPct === null) {
    throw new Error(`No rate limit headers in response (HTTP ${response.status}): ${body.slice(0, 200)}`);
  }

  return { fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt, raw: body };
}

// ── DeepSeek balance vendor ────────────────────────────────────────────────

interface DeepSeekBalanceInfo {
  currency: "USD" | "CNY";
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface DeepSeekBalanceResponse {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
}

async function fetchDeepSeekBalance(
  apiKey: string,
  monthlyBudgetUsd: number | null
): Promise<UsageData> {
  const response = await fetch("https://api.deepseek.com/user/balance", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek balance API returned ${response.status}: ${await response.text()}`);
  }

  const data: DeepSeekBalanceResponse = (await response.json()) as DeepSeekBalanceResponse;
  const usd = data.balance_infos.find((b) => b.currency === "USD");
  const balanceUsd = usd ? parseFloat(usd.total_balance) : null;

  // Map balance → seven_day_pct as "% of monthly budget consumed".
  // Anchoring to monthly budget rather than topped-up balance because top-ups
  // can happen mid-month; the budget is the user's intent.
  let pct: number | null = null;
  if (monthlyBudgetUsd !== null && monthlyBudgetUsd > 0 && balanceUsd !== null) {
    const used = monthlyBudgetUsd - balanceUsd;
    pct = Math.max(0, Math.min(100, (used / monthlyBudgetUsd) * 100));
  }

  return {
    fiveHourPct: null,
    fiveHourResetsAt: null,
    sevenDayPct: pct,
    sevenDayResetsAt: firstOfNextMonthUtc(),
    raw: JSON.stringify({
      vendor: "deepseek-balance",
      balanceUsd,
      monthlyBudgetUsd,
      isAvailable: data.is_available,
      apiResponse: data,
    }),
  };
}

// ── OpenAI Codex CLI session rate limits vendor ────────────────────────────

interface CodexRolloutFile {
  path: string;
  mtimeMs: number;
}

function expandHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

async function findCodexRolloutFiles(dir: string): Promise<CodexRolloutFile[]> {
  const files: CodexRolloutFile[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          const st = await stat(full);
          files.push({ path: full, mtimeMs: st.mtimeMs });
        } catch {
          // File may disappear while a Codex session rotates; skip it.
        }
      }
    }
  }

  await walk(dir);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findNestedCodexRateLimits(
  value: unknown,
  seen: Set<object> = new Set()
): Record<string, unknown> | null {
  if (typeof value === "string") {
    if (!value.includes("rate_limits")) return null;
    try {
      return findNestedCodexRateLimits(JSON.parse(value), seen);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    for (const item of value) {
      const found = findNestedCodexRateLimits(item, seen);
      if (found) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const candidate = value.rate_limits;
  if (isRecord(candidate) && isRecord(candidate.primary)) {
    return candidate;
  }

  for (const child of Object.values(value)) {
    const found = findNestedCodexRateLimits(child, seen);
    if (found) return found;
  }
  return null;
}

async function readCodexRateLimitsFromFile(jsonlPath: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(jsonlPath, "utf8");
  let latest: Record<string, unknown> | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim() || !line.includes("rate_limits")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const found = findNestedCodexRateLimits(parsed);
    if (found) latest = found;
  }

  return latest;
}

function usedPercent(window: unknown): number | null {
  if (!isRecord(window)) return null;
  return typeof window.used_percent === "number" && Number.isFinite(window.used_percent)
    ? window.used_percent
    : null;
}

function epochSecondsToIso(value: unknown): string | null {
  const seconds = typeof value === "number" || typeof value === "string"
    ? Number(value)
    : NaN;
  if (!Number.isFinite(seconds)) return null;
  // Truncate fractional seconds — keeps serialized resets_at stable poll-to-poll.
  const date = new Date(Math.floor(seconds) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function resetTime(window: unknown): string | null {
  if (!isRecord(window)) return null;
  return epochSecondsToIso(window.resets_at);
}

export async function fetchCodexRateLimits(configDir: string, now: Date = new Date()): Promise<UsageData> {
  const sessionsDir = path.join(expandHome(configDir), "sessions");
  const rolloutFiles = (await findCodexRolloutFiles(sessionsDir)).slice(0, 3);

  for (const file of rolloutFiles) {
    const rateLimits = await readCodexRateLimitsFromFile(file.path);
    if (!rateLimits) continue;

    // Staleness guard: codex rate_limits come from session transcripts, not a
    // live API. A window whose resets_at is already in the past has rolled over
    // since the transcript was written — its used_percent describes a PREVIOUS
    // window. Report that window as no-signal instead of re-publishing days-old
    // numbers as a fresh poll: an idle machine would otherwise shadow fresh
    // data pushed by other machines (latest-poll-wins at the central receiver)
    // and pace math would extrapolate absurd expected percentages.
    const nowMs = now.getTime();
    const expired = (iso: string | null): boolean => iso !== null && Date.parse(iso) <= nowMs;
    let fiveHourPct = usedPercent(rateLimits.primary);
    let fiveHourResetsAt = resetTime(rateLimits.primary);
    let sevenDayPct = usedPercent(rateLimits.secondary);
    let sevenDayResetsAt = resetTime(rateLimits.secondary);
    if (expired(fiveHourResetsAt)) {
      fiveHourPct = null;
      fiveHourResetsAt = null;
    }
    if (expired(sevenDayResetsAt)) {
      sevenDayPct = null;
      sevenDayResetsAt = null;
    }
    // Older rollout files can only be staler — don't bother scanning further.
    // NOTE: keep "rate_limit"/"429" OUT of this message — it must not trip
    // the poller's isRateLimitError detection (it's staleness, not throttling).
    if (fiveHourResetsAt === null && sevenDayResetsAt === null) {
      throw new Error(
        `codex usage windows in ${file.path} are fully expired (codex idle here since they were recorded); no current usage signal`,
      );
    }

    return {
      fiveHourPct,
      fiveHourResetsAt,
      sevenDayPct,
      sevenDayResetsAt,
      raw: JSON.stringify({
        vendor: "openai-codex",
        source: file.path,
        rate_limits: rateLimits,
      }),
    };
  }

  throw new Error(`No codex usage data found under ${sessionsDir}`);
}

// ── Public: fetch usage for a profile (vendor-aware) ───────────────────────

/**
 * Whether a vendor exposes a 5h/7d rate-limit snapshot the poller can read.
 * Token-tally-only vendors (antigravity) have none — their usage comes from the
 * conversation .db tally, not a poll — so callers skip them quietly instead of
 * calling `fetchUsage` and logging the resulting "no rate-limit usage" throw as
 * a per-loop failure.
 */
export function vendorPollsRateLimitSnapshot(vendor: ProfileVendor): boolean {
  return vendor !== "antigravity";
}

export async function fetchUsage(configDirOrProfile: string | Profile): Promise<UsageData> {
  if (typeof configDirOrProfile === "string") {
    return fetchAnthropicOAuth(configDirOrProfile);
  }
  const profile = configDirOrProfile;
  switch (profile.vendor) {
    case "deepseek-balance": {
      if (!profile.api_key) {
        throw new Error(`Profile "${profile.name}" is vendor=deepseek-balance but has no api_key set`);
      }
      return fetchDeepSeekBalance(profile.api_key, profile.monthly_budget_usd);
    }
    case "openai-codex":
      return fetchCodexRateLimits(profile.config_dir);
    case "antigravity":
      // Antigravity exposes no 5h/7d rate-limit signal — it's a token-tally-only
      // vendor (usage comes from the conversation .db tally, not a poll). Surface
      // a clear, non-anthropic error so the poller records a null snapshot rather
      // than mis-reading OAuth tokens from the config dir.
      throw new Error(
        `Profile "${profile.name}" is vendor=antigravity (token-tally only); no 5h/7d rate-limit usage to poll`,
      );
    case "anthropic-oauth":
    default:
      return fetchAnthropicOAuth(profile.config_dir);
  }
}

async function fetchAnthropicOAuth(configDir: string): Promise<UsageData> {
  const tokens = await getOAuthTokens(configDir);
  if (!tokens) {
    throw new Error(`No OAuth tokens found for ${configDir}`);
  }

  // Option A: dedicated usage endpoint (preferred — zero quota cost)
  let optionAError: unknown;
  if (hasProfileScope(tokens)) {
    try {
      const data = await fetchViaUsageApi(tokens);
      log(`Option A (usage API) succeeded for ${configDir}`);
      return data;
    } catch (err) {
      optionAError = err;
      log(`Option A (usage API) failed for ${configDir}: ${err}`);
    }
  } else {
    log(`Skipping Option A for ${configDir}: missing user:profile scope`);
  }

  // Option B: minimal API call + rate limit headers
  if (hasInferenceScope(tokens)) {
    try {
      const data = await fetchViaHeaders(tokens);
      log(`Option B (headers) succeeded for ${configDir}`);
      return data;
    } catch (err) {
      log(`Option B (headers) failed for ${configDir}: ${err}`);
      throw err;
    }
  }

  // Don't swallow the real failure: when Option A failed (e.g. persistent 429)
  // and there's no inference scope to fall back on, surface that error — it
  // carries the status the poller's rate-limit detection needs.
  if (optionAError !== undefined) {
    throw optionAError instanceof Error
      ? optionAError
      : new Error(String(optionAError));
  }

  throw new Error(`OAuth tokens for ${configDir} lack required scopes (have: ${tokens.scopes?.join(", ")})`);
}
