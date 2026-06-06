export type ProfileVendor = "anthropic-oauth" | "deepseek-balance" | "openai-codex";

// ── Multi-tenant: accounts, ingest tokens, machines ──────────────────────────

export interface Account {
  id: number;
  identity: string;
  display_name: string | null;
  created_at: string;
}

export interface IngestToken {
  id: number;
  account_id: number;
  machine: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Masked view returned to the dashboard (never exposes the hash). */
export interface IngestTokenMasked {
  id: number;
  account_id: number;
  machine: string;
  token_preview: string; // last 6 chars of the hash, for disambiguation only
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface MachineRow {
  account_id: number;
  name: string;
  first_seen: string;
  last_seen: string;
}

// ── Fine-grained token usage grain ───────────────────────────────────────────

export type TokenUsageSource = "local" | "ingest";

export interface TokenUsageInput {
  account_id: number;
  profile: string;
  machine: string;
  session_id: string;
  model: string;
  settings_hash: string;
  settings_json: string;
  day: string; // YYYY-MM-DD
  tokens_in: number;
  tokens_out: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  source: TokenUsageSource;
}

export interface TokenUsageRow extends TokenUsageInput {
  id: number;
  updated_at: string;
}

// ── Live multi-machine context sessions ──────────────────────────────────────

export interface ContextSessionInput {
  account_id: number;
  profile: string;
  machine: string;
  session_id: string;
  model: string | null;
  settings_json: string;
  context_tokens: number | null;
  context_pct: number | null;
  effective_limit: number | null;
  last_active_at: string; // ISO
}

export interface ContextSessionRow extends ContextSessionInput {
  updated_at: string;
}

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

// ── Fine-grained reports (token_usage) ───────────────────────────────────────

export interface ReportTotals {
  tokens_in: number;
  tokens_out: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  total_tokens: number;
  cost_usd: number;
}

export interface ReportDayPoint extends ReportTotals {
  day: string;
}

export interface ReportBreakdown extends ReportTotals {
  /** The drill key value: machine name, session_id, model id, or profile. */
  key: string;
}

export interface ReportProfileGroup extends ReportTotals {
  profile: string;
  by_machine: ReportBreakdown[];
  by_day: ReportDayPoint[];
  /** Present only when drilling deeper than profile (machine/session/model). */
  drill?: ReportBreakdown[];
}

export type ReportDrill = "account" | "profile" | "machine" | "session" | "model";

export interface FineTokenReport {
  granularity: "daily" | "weekly";
  days: number;
  since_day: string;
  drill: ReportDrill;
  account: string;
  profiles: ReportProfileGroup[];
  total: ReportTotals;
}
