import { getOAuthTokens, hasProfileScope, hasInferenceScope } from "./auth.js";
import type { OAuthTokens } from "./auth.js";

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
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

async function fetchViaUsageApi(tokens: OAuthTokens): Promise<UsageData> {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      "Authorization": `Bearer ${tokens.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}: ${await response.text()}`);
  }

  const data: UsageApiResponse = await response.json() as UsageApiResponse;
  const raw = JSON.stringify(data);

  return {
    fiveHourPct: data.five_hour?.utilization ?? null,
    fiveHourResetsAt: data.five_hour?.resets_at ?? null,
    sevenDayPct: data.seven_day?.utilization ?? null,
    sevenDayResetsAt: data.seven_day?.resets_at ?? null,
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

// ── Public: fetch with A → B fallback ───────────────────────────────────────

export async function fetchUsage(configDir: string): Promise<UsageData> {
  const tokens = await getOAuthTokens(configDir);
  if (!tokens) {
    throw new Error(`No OAuth tokens found for ${configDir}`);
  }

  // Option A: dedicated usage endpoint (preferred — zero quota cost)
  if (hasProfileScope(tokens)) {
    try {
      const data = await fetchViaUsageApi(tokens);
      log(`Option A (usage API) succeeded for ${configDir}`);
      return data;
    } catch (err) {
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

  throw new Error(`OAuth tokens for ${configDir} lack required scopes (have: ${tokens.scopes?.join(", ")})`);
}
