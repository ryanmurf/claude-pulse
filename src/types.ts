export interface Profile {
  name: string;
  config_dir: string;
  poll_interval_minutes: number;
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
}

export interface PollResult {
  profile: string;
  success: boolean;
  snapshot?: UsageSnapshot;
  error?: string;
}

export type AlertType = "five_hour_threshold" | "seven_day_threshold" | "auth_failure";

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
