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

interface CodexSnapshot {
  rateLimits: Record<string, unknown>;
  /** Timestamp of the rate_limits ENTRY itself (epoch ms), or null if absent. */
  tsMs: number | null;
}

/**
 * Epoch-ms timestamp of a rollout line, read from the event envelope's
 * top-level `timestamp` (Codex writes ISO-8601 strings; epoch numbers are
 * tolerated). Returns null when absent/unparseable so the caller can fall back
 * to the file mtime.
 */
function lineTimestampMs(parsed: unknown): number | null {
  if (!isRecord(parsed)) return null;
  const t = parsed.timestamp;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof t === "number" && Number.isFinite(t)) {
    // Values below ~1e12 are epoch seconds; otherwise already milliseconds.
    return t < 1e12 ? t * 1000 : t;
  }
  return null;
}

async function readCodexRateLimitsFromFile(jsonlPath: string): Promise<CodexSnapshot | null> {
  const raw = await readFile(jsonlPath, "utf8");
  let latest: CodexSnapshot | null = null;

  // Keep the LAST rate_limits-bearing line in the file (rollout lines are
  // appended chronologically) and carry its entry timestamp so the caller can
  // rank snapshots ACROSS files by when they were actually recorded.
  for (const line of raw.split("\n")) {
    if (!line.trim() || !line.includes("rate_limits")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const found = findNestedCodexRateLimits(parsed);
    if (found) latest = { rateLimits: found, tsMs: lineTimestampMs(parsed) };
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
  const rolloutFiles = await findCodexRolloutFiles(sessionsDir); // newest mtime first

  // Pick the snapshot with the newest rate_limits-ENTRY timestamp across files —
  // NOT the newest file mtime. A long-lived session's rollout keeps getting
  // appended (resumes, non-API events) long after its last rate_limits line, so
  // the newest-mtime file can carry a STALER reading than an older-mtime file
  // whose last API call was more recent. Ranking by file mtime froze the gauge
  // on an old % (e.g. 16% used) while a fresher reading (52%) sat in an
  // older-mtime file. Rank by the entry's own timestamp instead.
  //
  // Early-out: a rate_limits entry's timestamp can never exceed its file's
  // mtime, so once our best entry is at least as new as the next file's mtime,
  // no remaining (lower-mtime) file can beat it — stop reading. (Falls back to
  // file mtime for the rare rollout line that carries no timestamp.)
  let best: { rateLimits: Record<string, unknown>; tsMs: number; path: string } | null = null;
  for (const file of rolloutFiles) {
    if (best && best.tsMs >= file.mtimeMs) break;
    const snap = await readCodexRateLimitsFromFile(file.path);
    if (!snap) continue;
    const tsMs = snap.tsMs ?? file.mtimeMs;
    if (!best || tsMs > best.tsMs) {
      best = { rateLimits: snap.rateLimits, tsMs, path: file.path };
    }
  }

  if (!best) {
    throw new Error(`No codex usage data found under ${sessionsDir}`);
  }
  const { rateLimits } = best;

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
  // NOTE: keep "rate_limit"/"429" OUT of this message — it must not trip
  // the poller's isRateLimitError detection (it's staleness, not throttling).
  if (fiveHourResetsAt === null && sevenDayResetsAt === null) {
    throw new Error(
      `codex usage windows in ${best.path} are fully expired (codex idle here since they were recorded); no current usage signal`,
    );
  }

  return {
    fiveHourPct,
    fiveHourResetsAt,
    sevenDayPct,
    sevenDayResetsAt,
    raw: JSON.stringify({
      vendor: "openai-codex",
      source: best.path,
      rate_limits: rateLimits,
    }),
  };
}

// ── OpenAI Codex live usage API (/wham/usage) ──────────────────────────────
// Session rate_limits in rollout transcripts only update when THIS machine's
// codex CLI makes a request, so an idle machine reports stale/expired windows —
// and on the central dashboard an idle machine's nulls shadow other machines'
// data (latest-poll-wins). The undocumented /wham/usage backend endpoint returns
// the same ACCOUNT-WIDE rate-limit windows the Codex app shows, regardless of
// which machine ran codex, so any host with a valid ~/.codex/auth.json login can
// report the true current usage. Read-only GET; the token is never logged or
// stored (the response's identity fields are dropped from `raw`).

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

async function readCodexAuth(
  configDir: string,
): Promise<{ accessToken: string; accountId: string } | null> {
  const authPath = path.join(expandHome(configDir), "auth.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.tokens)) return null;
    const t = parsed.tokens;
    const accessToken = typeof t.access_token === "string" ? t.access_token : "";
    const accountId = typeof t.account_id === "string" ? t.account_id : "";
    if (!accessToken || !accountId) return null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

function codexWindowPct(window: unknown): number | null {
  if (!isRecord(window)) return null;
  return typeof window.used_percent === "number" && Number.isFinite(window.used_percent)
    ? window.used_percent
    : null;
}

function codexWindowReset(window: unknown): string | null {
  return isRecord(window) ? epochSecondsToIso(window.reset_at) : null;
}

/**
 * Fetch live, account-wide codex usage from the undocumented /wham/usage backend
 * endpoint using the existing ~/.codex/auth.json login. Maps
 * rate_limit.primary_window → 5h and secondary_window → 7d. Throws on missing
 * auth or any non-2xx so callers can fall back to transcript parsing. The stored
 * `raw` keeps only the rate-limit windows + plan — NEVER the identity fields
 * (email/user_id/account_id) the response also carries.
 */
export async function fetchCodexUsageApi(configDir: string): Promise<UsageData> {
  const auth = await readCodexAuth(configDir);
  if (!auth) {
    throw new Error(`codex auth.json missing or has no access token under ${configDir}`);
  }
  const res = await fetch(CODEX_USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-ID": auth.accountId,
      originator: "Codex Desktop",
      "User-Agent": "claude-pulse-codex-usage/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`codex usage API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const data: unknown = await res.json();
  const rl = isRecord(data) && isRecord(data.rate_limit) ? data.rate_limit : null;
  if (!rl) {
    throw new Error("codex usage API response had no rate_limit object");
  }
  const primary = rl.primary_window;
  const secondary = rl.secondary_window;
  return {
    fiveHourPct: codexWindowPct(primary),
    fiveHourResetsAt: codexWindowReset(primary),
    sevenDayPct: codexWindowPct(secondary),
    sevenDayResetsAt: codexWindowReset(secondary),
    raw: JSON.stringify({
      vendor: "openai-codex",
      source: "api:/wham/usage",
      plan_type: isRecord(data) && typeof data.plan_type === "string" ? data.plan_type : null,
      rate_limit: {
        allowed: rl.allowed ?? null,
        limit_reached: rl.limit_reached ?? null,
        primary_window: isRecord(primary) ? primary : null,
        secondary_window: isRecord(secondary) ? secondary : null,
      },
    }),
  };
}

/**
 * Codex usage for a profile: prefer the live, account-wide /wham/usage endpoint
 * (authoritative regardless of which machine ran codex); fall back to local
 * rollout-transcript parsing when auth.json is absent or the API call fails
 * (network/expired token). On double failure the transcript error is surfaced —
 * it carries the "fully expired" staleness semantics (and deliberately omits
 * rate-limit trigger substrings) the poller relies on.
 */
export async function fetchCodexUsage(configDir: string, now: Date = new Date()): Promise<UsageData> {
  try {
    return await fetchCodexUsageApi(configDir);
  } catch {
    return await fetchCodexRateLimits(configDir, now);
  }
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
      return fetchCodexUsage(profile.config_dir);
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

      // 401 = the access token was REJECTED (expired/revoked even if the file
      // says otherwise). Force an in-memory refresh and retry once — covers
      // idle profiles whose credentials file Claude Code isn't refreshing.
      if (err instanceof Error && /Usage API returned 401\b/.test(err.message) && tokens.refreshToken) {
        const refreshedTokens = await getOAuthTokens(configDir, { forceRefresh: true });
        if (refreshedTokens && refreshedTokens.accessToken !== tokens.accessToken) {
          try {
            const data = await fetchViaUsageApi(refreshedTokens);
            log(`Option A (usage API) succeeded for ${configDir} after in-memory token refresh`);
            return data;
          } catch (retryErr) {
            optionAError = retryErr;
            log(`Option A retry after token refresh failed for ${configDir}: ${retryErr}`);
          }
        }
      }
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
