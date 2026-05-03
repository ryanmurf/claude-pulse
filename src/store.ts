import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type {
  Profile,
  ProfileVendor,
  UsageSnapshot,
  GeminiQuotaSnapshot,
  AlertSubscription,
  AlertEvent,
  AlertType,
} from "./types.js";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".claude-pulse");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "usage.db");

let db: DatabaseSync;

/**
 * Initialize the database. Optionally pass a custom dbPath for testing.
 * If no path is provided, uses ~/.claude-pulse/usage.db.
 */
export function initDb(dbPath?: string): void {
  if (db) return;

  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
  const resolvedDir = path.dirname(resolvedPath);

  fs.mkdirSync(resolvedDir, { recursive: true });
  db = new DatabaseSync(resolvedPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      name TEXT PRIMARY KEY,
      config_dir TEXT NOT NULL,
      poll_interval_minutes INTEGER NOT NULL DEFAULT 5,
      vendor TEXT NOT NULL DEFAULT 'anthropic-oauth',
      monthly_budget_usd REAL,
      api_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migrate older DBs that pre-date the vendor/budget/api_key columns.
  const cols = (db
    .prepare("PRAGMA table_info(profiles)")
    .all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("vendor")) {
    db.exec("ALTER TABLE profiles ADD COLUMN vendor TEXT NOT NULL DEFAULT 'anthropic-oauth'");
  }
  if (!cols.includes("monthly_budget_usd")) {
    db.exec("ALTER TABLE profiles ADD COLUMN monthly_budget_usd REAL");
  }
  if (!cols.includes("api_key")) {
    db.exec("ALTER TABLE profiles ADD COLUMN api_key TEXT");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
      five_hour_pct REAL,
      five_hour_resets_at TEXT,
      seven_day_pct REAL,
      seven_day_resets_at TEXT,
      raw_response TEXT,
      polled_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_snapshots_profile_time
      ON usage_snapshots(profile, polled_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS gemini_quota (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      model_id TEXT NOT NULL,
      remaining_fraction REAL NOT NULL,
      remaining_amount TEXT,
      reset_time TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gemini_quota_model_time
      ON gemini_quota(model_id, timestamp)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
      alert_type TEXT NOT NULL CHECK(alert_type IN ('five_hour_threshold', 'seven_day_threshold', 'auth_failure')),
      threshold REAL,
      channel TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 30,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
      profile TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      current_value REAL,
      threshold REAL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_events_sub
      ON alert_events(subscription_id, triggered_at)
  `);
}

function getDb(): DatabaseSync {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function ensureDefaultProfiles(): void {
  const d = getDb();
  const homeDir = os.homedir();

  const defaults = [
    { name: "claude-hd", config_dir: path.join(homeDir, ".claude-hd") },
    { name: "claude-max", config_dir: path.join(homeDir, ".claude-max") },
  ];

  const stmt = d.prepare(
    `INSERT INTO profiles (name, config_dir, poll_interval_minutes)
     VALUES (?, ?, 5)
     ON CONFLICT(name) DO NOTHING`
  );

  for (const p of defaults) {
    stmt.run(p.name, p.config_dir);
  }
}

export function listProfiles(): Profile[] {
  const d = getDb();
  return d.prepare("SELECT * FROM profiles ORDER BY name").all() as unknown as Profile[];
}

export function redactProfile(p: Profile): Omit<Profile, "api_key"> & { api_key: string | null } {
  return { ...p, api_key: p.api_key ? "***" : null };
}

export function getProfile(name: string): Profile | undefined {
  const d = getDb();
  const row = d.prepare("SELECT * FROM profiles WHERE name = ?").get(name);
  return row as unknown as Profile | undefined;
}

export function addProfile(
  name: string,
  configDir: string,
  pollIntervalMinutes: number = 5,
  vendor: ProfileVendor = "anthropic-oauth",
  monthlyBudgetUsd: number | null = null,
  apiKey: string | null = null
): Profile {
  const d = getDb();
  d.prepare(
    `INSERT INTO profiles (name, config_dir, poll_interval_minutes, vendor, monthly_budget_usd, api_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name, configDir, pollIntervalMinutes, vendor, monthlyBudgetUsd, apiKey);
  return getProfile(name)!;
}

export function updateProfileBudget(
  name: string,
  monthlyBudgetUsd: number | null
): boolean {
  const d = getDb();
  const result = d.prepare(
    `UPDATE profiles
     SET monthly_budget_usd = ?, updated_at = datetime('now')
     WHERE name = ?`
  ).run(monthlyBudgetUsd, name);
  return Number(result.changes) > 0;
}

export function updateProfileApiKey(
  name: string,
  apiKey: string | null
): boolean {
  const d = getDb();
  const result = d.prepare(
    `UPDATE profiles
     SET api_key = ?, updated_at = datetime('now')
     WHERE name = ?`
  ).run(apiKey, name);
  return Number(result.changes) > 0;
}

export function removeProfile(name: string): boolean {
  const d = getDb();
  // Delete snapshots first (even though CASCADE should handle it)
  d.prepare("DELETE FROM usage_snapshots WHERE profile = ?").run(name);
  const result = d.prepare("DELETE FROM profiles WHERE name = ?").run(name);
  return Number(result.changes) > 0;
}

export function updatePollInterval(
  name: string,
  intervalMinutes: number
): boolean {
  const d = getDb();
  const result = d.prepare(
    `UPDATE profiles
     SET poll_interval_minutes = ?, updated_at = datetime('now')
     WHERE name = ?`
  ).run(intervalMinutes, name);
  return Number(result.changes) > 0;
}

export function insertSnapshot(
  profile: string,
  fiveHourPct: number | null,
  fiveHourResetsAt: string | null,
  sevenDayPct: number | null,
  sevenDayResetsAt: string | null,
  rawResponse: string | null
): UsageSnapshot {
  const d = getDb();
  const result = d.prepare(
    `INSERT INTO usage_snapshots
       (profile, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, raw_response)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    profile,
    fiveHourPct,
    fiveHourResetsAt,
    sevenDayPct,
    sevenDayResetsAt,
    rawResponse
  );

  return d.prepare("SELECT * FROM usage_snapshots WHERE id = ?")
    .get(result.lastInsertRowid) as unknown as UsageSnapshot;
}

export function getLastSuccessfulSnapshot(
  profile: string
): UsageSnapshot | undefined {
  const d = getDb();
  const row = d.prepare(
    `SELECT * FROM usage_snapshots
     WHERE profile = ?
       AND (five_hour_resets_at IS NOT NULL OR seven_day_resets_at IS NOT NULL)
     ORDER BY polled_at DESC
     LIMIT 1`
  ).get(profile);
  return row as unknown as UsageSnapshot | undefined;
}

export function getLatestSnapshot(
  profile: string
): UsageSnapshot | undefined {
  const d = getDb();
  const row = d.prepare(
    `SELECT * FROM usage_snapshots
     WHERE profile = ?
     ORDER BY polled_at DESC
     LIMIT 1`
  ).get(profile);
  return row as unknown as UsageSnapshot | undefined;
}

export function getLatestSnapshots(): UsageSnapshot[] {
  const d = getDb();
  return d.prepare(
    `SELECT s.*
     FROM usage_snapshots s
     INNER JOIN (
       SELECT profile, MAX(polled_at) as max_polled
       FROM usage_snapshots
       GROUP BY profile
     ) latest ON s.profile = latest.profile AND s.polled_at = latest.max_polled
     ORDER BY s.profile`
  ).all() as unknown as UsageSnapshot[];
}

export function getHistory(
  profile: string,
  hours: number = 24,
  limit: number = 100
): UsageSnapshot[] {
  const d = getDb();
  return d.prepare(
    `SELECT * FROM usage_snapshots
     WHERE profile = ?
       AND polled_at >= datetime('now', '-' || ? || ' hours')
     ORDER BY polled_at DESC
     LIMIT ?`
  ).all(profile, hours, limit) as unknown as UsageSnapshot[];
}

// --- Gemini quota functions ---

export function insertGeminiQuotaSnapshots(
  buckets: {
    modelId: string;
    remainingFraction: number;
    remainingAmount: string | null;
    resetTime: string | null;
  }[]
): GeminiQuotaSnapshot[] {
  if (buckets.length === 0) return [];

  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO gemini_quota
       (model_id, remaining_fraction, remaining_amount, reset_time)
     VALUES (?, ?, ?, ?)`
  );
  const rows: GeminiQuotaSnapshot[] = [];

  d.exec("BEGIN");
  try {
    for (const bucket of buckets) {
      const result = stmt.run(
        bucket.modelId,
        bucket.remainingFraction,
        bucket.remainingAmount,
        bucket.resetTime
      );
      rows.push(
        d.prepare("SELECT * FROM gemini_quota WHERE id = ?")
          .get(result.lastInsertRowid) as unknown as GeminiQuotaSnapshot
      );
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }

  return rows;
}

export function getLatestGeminiQuota(): GeminiQuotaSnapshot[] {
  const d = getDb();
  return d.prepare(
    `SELECT *
     FROM gemini_quota
     WHERE id IN (
       SELECT MAX(id)
       FROM gemini_quota
       GROUP BY model_id
     )
     ORDER BY model_id`
  ).all() as unknown as GeminiQuotaSnapshot[];
}

// --- Alert Subscription functions ---

export function createAlertSubscription(
  profile: string,
  alertType: AlertType,
  threshold: number | null,
  channel: string | null,
  cooldownMinutes: number = 30
): AlertSubscription {
  const d = getDb();
  const result = d.prepare(
    `INSERT INTO alert_subscriptions (profile, alert_type, threshold, channel, cooldown_minutes)
     VALUES (?, ?, ?, ?, ?)`
  ).run(profile, alertType, threshold, channel, cooldownMinutes);
  return d.prepare("SELECT * FROM alert_subscriptions WHERE id = ?")
    .get(result.lastInsertRowid) as unknown as AlertSubscription;
}

export function removeAlertSubscription(id: number): boolean {
  const d = getDb();
  const result = d.prepare("DELETE FROM alert_subscriptions WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function listAlertSubscriptions(profile?: string): AlertSubscription[] {
  const d = getDb();
  if (profile) {
    return d.prepare(
      "SELECT * FROM alert_subscriptions WHERE profile = ? ORDER BY id"
    ).all(profile) as unknown as AlertSubscription[];
  }
  return d.prepare(
    "SELECT * FROM alert_subscriptions ORDER BY profile, id"
  ).all() as unknown as AlertSubscription[];
}

export function getAlertSubscription(id: number): AlertSubscription | undefined {
  const d = getDb();
  const row = d.prepare("SELECT * FROM alert_subscriptions WHERE id = ?").get(id);
  return row as unknown as AlertSubscription | undefined;
}

export function getEnabledAlertSubscriptions(profile: string): AlertSubscription[] {
  const d = getDb();
  return d.prepare(
    "SELECT * FROM alert_subscriptions WHERE profile = ? AND enabled = 1 ORDER BY id"
  ).all(profile) as unknown as AlertSubscription[];
}

// --- Alert Event functions ---

export function createAlertEvent(
  subscriptionId: number,
  profile: string,
  alertType: AlertType,
  message: string,
  currentValue: number | null,
  threshold: number | null
): AlertEvent {
  const d = getDb();
  const result = d.prepare(
    `INSERT INTO alert_events (subscription_id, profile, alert_type, message, current_value, threshold)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(subscriptionId, profile, alertType, message, currentValue, threshold);
  return d.prepare("SELECT * FROM alert_events WHERE id = ?")
    .get(result.lastInsertRowid) as unknown as AlertEvent;
}

export function getTriggeredAlerts(
  profile?: string,
  sinceHours: number = 24,
  unacknowledgedOnly: boolean = false
): AlertEvent[] {
  const d = getDb();
  let sql = `SELECT * FROM alert_events
     WHERE triggered_at >= datetime('now', '-' || ? || ' hours')`;
  const params: (string | number)[] = [sinceHours];

  if (profile) {
    sql += " AND profile = ?";
    params.push(profile);
  }
  if (unacknowledgedOnly) {
    sql += " AND acknowledged = 0";
  }
  sql += " ORDER BY triggered_at DESC";

  return d.prepare(sql).all(...params) as unknown as AlertEvent[];
}

export function acknowledgeAlert(eventId: number): boolean {
  const d = getDb();
  const result = d.prepare(
    "UPDATE alert_events SET acknowledged = 1 WHERE id = ? AND acknowledged = 0"
  ).run(eventId);
  return Number(result.changes) > 0;
}

export function acknowledgeAllAlerts(profile?: string): number {
  const d = getDb();
  if (profile) {
    const result = d.prepare(
      "UPDATE alert_events SET acknowledged = 1 WHERE profile = ? AND acknowledged = 0"
    ).run(profile);
    return Number(result.changes);
  }
  const result = d.prepare(
    "UPDATE alert_events SET acknowledged = 1 WHERE acknowledged = 0"
  ).run();
  return Number(result.changes);
}

export function getLastAlertEvent(subscriptionId: number): AlertEvent | undefined {
  const d = getDb();
  const row = d.prepare(
    `SELECT * FROM alert_events
     WHERE subscription_id = ?
     ORDER BY triggered_at DESC
     LIMIT 1`
  ).get(subscriptionId);
  return row as unknown as AlertEvent | undefined;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined!;
  }
}
