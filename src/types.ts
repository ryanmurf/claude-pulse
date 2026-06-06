export type ProfileVendor = "anthropic-oauth" | "deepseek-balance" | "openai-codex";

export interface Profile {
  name: string;
  config_dir: string;
  poll_interval_minutes: number;
  vendor: ProfileVendor;
  monthly_budget_usd: number | null;
  api_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface RateLimit {
  used_percentage: number;
  resets_at: string;
}

export interface RateLimits {
  five_hour?: RateLimit;
  seven_day?: RateLimit;
}

export interface ClaudeResponse {
  result?: string;
  rate_limits?: RateLimits;
  [key: string]: unknown;
}

export interface UsageSnapshot {
  id: number;
  profile: string;
  five_hour_pct: number | null;
  five_hour_resets_at: string | null;
  seven_day_pct: number | null;
  seven_day_resets_at: string | null;
  raw_response: string | null;
  polled_at: string;
  // Context-window monitoring (nullable for backwards compat with old rows)
  context_tokens: number | null;
  context_pct: number | null;
  context_session_id: string | null;
  context_model: string | null;
  context_effective_limit: number | null;
  context_last_reset_at: string | null;
}

export interface GeminiQuotaSnapshot {
  id: number;
  timestamp: string;
  model_id: string;
  remaining_fraction: number;
  remaining_amount: string | null;
  reset_time: string | null;
}

export interface GeminiQuotaUsage {
  model_id: string;
  used_pct: number;
  reset_time: string | null;
  remaining_amount: string | null;
  timestamp: string;
}

export interface PollResult {
  profile: string;
  success: boolean;
  snapshot?: UsageSnapshot;
  error?: string;
}

export type AlertType =
  | "five_hour_threshold"
  | "seven_day_threshold"
  | "auth_failure"
  | "context_threshold";

export interface AlertSubscription {
  id: number;
  profile: string;
  alert_type: AlertType;
  threshold: number | null;
  channel: string | null;
  cooldown_minutes: number;
  enabled: number;
  created_at: string;
}

export interface AlertEvent {
  id: number;
  subscription_id: number;
  profile: string;
  alert_type: AlertType;
  message: string;
  current_value: number | null;
  threshold: number | null;
  acknowledged: number;
  triggered_at: string;
}

export type TokenRollupSource = "local" | "ingest";

export interface TokenRollup {
  id: number;
  profile: string;
  host: string;
  day: string; // YYYY-MM-DD
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  source: TokenRollupSource;
  updated_at: string;
}

export interface TokenRollupInput {
  profile: string;
  host: string;
  day: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  source: TokenRollupSource;
}

export interface TokenReportTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface TokenReportDayPoint extends TokenReportTotals {
  day: string;
}

export interface TokenReportHostBreakdown extends TokenReportTotals {
  host: string;
}

export interface TokenReportProfile extends TokenReportTotals {
  profile: string;
  by_day: TokenReportDayPoint[];
  by_host: TokenReportHostBreakdown[];
}

export interface TokenReport {
  granularity: "daily" | "weekly";
  days: number;
  since_day: string;
  profiles: TokenReportProfile[];
  total: TokenReportTotals;
}
