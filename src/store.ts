import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
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
  TokenRollup,
  TokenRollupInput,
  TokenReport,
  TokenReportProfile,
  TokenReportTotals,
  TokenReportDayPoint,
  TokenReportHostBreakdown,
  Account,
  IngestToken,
  IngestTokenMasked,
  MachineRow,
  TokenUsageInput,
  TokenUsageRow,
  ContextSessionInput,
  ContextSessionRow,
  FineTokenReport,
  ReportDrill,
  ReportProfileGroup,
  ReportTotals,
  ReportDayPoint,
  ReportBreakdown,
} from "./types.js";
import {
  DEFAULT_PRICING,
  resolveRate,
  costForGrain,
  type PricingRow,
  type PricingOverrideRow,
} from "./pricing.js";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".claude-pulse");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "usage.db");

/** Fallback account identity when no X-Auth-Request-Email header is present. */
export const DEFAULT_ACCOUNT_IDENTITY =
  process.env.CLAUDE_PULSE_DEFAULT_ACCOUNT || "local";

/** sha-256 hex of a plaintext bearer token. Only the hash is ever stored. */
export function hashIngestToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Number of days after which a context_session is considered stale. */
const CONTEXT_STALE_DAYS = 1;

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
      polled_at TEXT NOT NULL DEFAULT (datetime('now')),
      context_tokens INTEGER,
      context_pct REAL,
      context_session_id TEXT,
      context_model TEXT,
      context_effective_limit INTEGER,
      context_last_reset_at TEXT
    )
  `);

  // Migrate older snapshot rows that pre-date the context-* / account_id columns.
  const snapCols = (db
    .prepare("PRAGMA table_info(usage_snapshots)")
    .all() as { name: string }[]).map((c) => c.name);
  for (const c of [
    "context_tokens INTEGER",
    "context_pct REAL",
    "context_session_id TEXT",
    "context_model TEXT",
    "context_effective_limit INTEGER",
    "context_last_reset_at TEXT",
    "account_id INTEGER",
  ]) {
    const colName = c.split(" ")[0];
    if (!snapCols.includes(colName)) {
      db.exec(`ALTER TABLE usage_snapshots ADD COLUMN ${c}`);
    }
  }

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
      alert_type TEXT NOT NULL CHECK(alert_type IN ('five_hour_threshold', 'seven_day_threshold', 'auth_failure', 'context_threshold')),
      threshold REAL,
      channel TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 30,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // For existing DBs created with the old CHECK constraint, recreate the table
  // without the constraint blocking 'context_threshold'. SQLite can't ALTER a
  // CHECK constraint in place, so detect-and-rebuild only when needed.
  // BEGIN IMMEDIATE acquires an exclusive write lock so concurrent claude-pulse
  // processes don't race on the DROP/RENAME.
  try {
    const tableSql = (db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alert_subscriptions'")
      .get() as { sql: string } | undefined)?.sql ?? "";
    if (tableSql && !tableSql.includes("context_threshold")) {
      db.exec("BEGIN IMMEDIATE");
      // Re-check inside the transaction in case another process already migrated.
      const recheckSql = (db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alert_subscriptions'")
        .get() as { sql: string } | undefined)?.sql ?? "";
      if (!recheckSql.includes("context_threshold")) {
        db.exec(`DROP TABLE IF EXISTS alert_subscriptions__new`);
        db.exec(`
          CREATE TABLE alert_subscriptions__new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
            alert_type TEXT NOT NULL CHECK(alert_type IN ('five_hour_threshold', 'seven_day_threshold', 'auth_failure', 'context_threshold')),
            threshold REAL,
            channel TEXT,
            cooldown_minutes INTEGER NOT NULL DEFAULT 30,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.exec(`INSERT INTO alert_subscriptions__new SELECT * FROM alert_subscriptions`);
        db.exec(`DROP TABLE alert_subscriptions`);
        db.exec(`ALTER TABLE alert_subscriptions__new RENAME TO alert_subscriptions`);
      }
      db.exec("COMMIT");
    }
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* noop */ }
    process.stderr.write(`[claude-pulse] alert_subscriptions migration warning: ${(e as Error).message}\n`);
  }

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL,
      host TEXT NOT NULL,
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'local',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile, host, day, model)
    )
  `);

  // Migration-safe guard: if an older DB has a token_rollups table missing the
  // source column (mirrors the vendor-column pattern above), add it.
  const trCols = (db
    .prepare("PRAGMA table_info(token_rollups)")
    .all() as { name: string }[]).map((c) => c.name);
  if (trCols.length > 0 && !trCols.includes("source")) {
    db.exec("ALTER TABLE token_rollups ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_rollups_day
      ON token_rollups(day, profile)
  `);

  // ── Multi-tenant tables ────────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity TEXT NOT NULL UNIQUE,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Seed the default/local account so single-tenant DBs + fallback always work.
  db.prepare(
    `INSERT INTO accounts (identity, display_name) VALUES (?, ?)
     ON CONFLICT(identity) DO NOTHING`
  ).run(DEFAULT_ACCOUNT_IDENTITY, DEFAULT_ACCOUNT_IDENTITY);

  // Backfill account_id on any pre-existing snapshots → the default account.
  const defaultAccountId = (db
    .prepare("SELECT id FROM accounts WHERE identity = ?")
    .get(DEFAULT_ACCOUNT_IDENTITY) as { id: number }).id;
  db.prepare(
    "UPDATE usage_snapshots SET account_id = ? WHERE account_id IS NULL"
  ).run(defaultAccountId);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      machine TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ingest_tokens_account
      ON ingest_tokens(account_id, machine)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, name)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      profile TEXT NOT NULL,
      machine TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      settings_hash TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      day TEXT NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cache_write_5m INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'local',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, profile, machine, session_id, model, settings_hash, day)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_report
      ON token_usage(account_id, day, profile)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS context_sessions (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      profile TEXT NOT NULL,
      machine TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      context_tokens INTEGER,
      context_pct REAL,
      effective_limit INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, profile, machine, session_id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_sessions_active
      ON context_sessions(account_id, last_active_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_defaults (
      model TEXT NOT NULL,
      settings_match_json TEXT NOT NULL DEFAULT '{}',
      input REAL NOT NULL,
      output REAL NOT NULL,
      cache_write_5m REAL NOT NULL,
      cache_write_1h REAL NOT NULL,
      cache_read REAL NOT NULL,
      source_url TEXT,
      as_of TEXT,
      UNIQUE(model, settings_match_json)
    )
  `);

  // Seed/refresh the placeholder default pricing rows (idempotent upsert).
  const seedDefault = db.prepare(
    `INSERT INTO pricing_defaults
       (model, settings_match_json, input, output, cache_write_5m, cache_write_1h, cache_read, source_url, as_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model, settings_match_json) DO NOTHING`
  );
  for (const r of DEFAULT_PRICING) {
    seedDefault.run(
      r.model,
      r.settings_match_json,
      r.input,
      r.output,
      r.cache_write_5m,
      r.cache_write_1h,
      r.cache_read,
      r.source_url ?? null,
      r.as_of ?? null,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_overrides (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      settings_match_json TEXT NOT NULL DEFAULT '{}',
      input REAL NOT NULL,
      output REAL NOT NULL,
      cache_write_5m REAL NOT NULL,
      cache_write_1h REAL NOT NULL,
      cache_read REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, model, settings_match_json)
    )
  `);
}

function getDb(): DatabaseSync {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** Get an account by identity, or undefined. */
export function getAccount(identity: string): Account | undefined {
  const d = getDb();
  return d.prepare("SELECT * FROM accounts WHERE identity = ?").get(identity) as
    | unknown as Account
    | undefined;
}

export function getAccountById(id: number): Account | undefined {
  const d = getDb();
  return d.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    | unknown as Account
    | undefined;
}

/**
 * Resolve (auto-create on first sight) the account for an identity. Pass the
 * `X-Auth-Request-Email` value, or undefined/null to use the default account.
 */
export function resolveAccount(identity?: string | null): Account {
  const d = getDb();
  const id = (identity && identity.trim()) || DEFAULT_ACCOUNT_IDENTITY;
  const existing = getAccount(id);
  if (existing) return existing;
  d.prepare(
    `INSERT INTO accounts (identity, display_name) VALUES (?, ?)
     ON CONFLICT(identity) DO NOTHING`
  ).run(id, id);
  return getAccount(id)!;
}

export function listAccounts(): Account[] {
  const d = getDb();
  return d.prepare("SELECT * FROM accounts ORDER BY id").all() as unknown as Account[];
}

function defaultAccountId(): number {
  return resolveAccount(DEFAULT_ACCOUNT_IDENTITY).id;
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

export interface ContextSnapshotFields {
  context_tokens: number | null;
  context_pct: number | null;
  context_session_id: string | null;
  context_model: string | null;
  context_effective_limit: number | null;
  context_last_reset_at: string | null;
}

export function insertSnapshot(
  profile: string,
  fiveHourPct: number | null,
  fiveHourResetsAt: string | null,
  sevenDayPct: number | null,
  sevenDayResetsAt: string | null,
  rawResponse: string | null,
  ctx?: ContextSnapshotFields | null,
  accountId?: number,
): UsageSnapshot {
  const d = getDb();
  const acct = accountId ?? defaultAccountId();
  const result = d.prepare(
    `INSERT INTO usage_snapshots
       (account_id, profile, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, raw_response,
        context_tokens, context_pct, context_session_id, context_model, context_effective_limit, context_last_reset_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    acct,
    profile,
    fiveHourPct,
    fiveHourResetsAt,
    sevenDayPct,
    sevenDayResetsAt,
    rawResponse,
    ctx?.context_tokens ?? null,
    ctx?.context_pct ?? null,
    ctx?.context_session_id ?? null,
    ctx?.context_model ?? null,
    ctx?.context_effective_limit ?? null,
    ctx?.context_last_reset_at ?? null,
  );

  return d.prepare("SELECT * FROM usage_snapshots WHERE id = ?")
    .get(result.lastInsertRowid) as unknown as UsageSnapshot;
}

/**
 * Update only the context-* fields on the most recent snapshot for a profile,
 * or insert a synthetic snapshot if none exists. Used by the standalone
 * context poller which runs on its own cadence.
 */
export function upsertContextOnLatestSnapshot(
  profile: string,
  ctx: ContextSnapshotFields,
  accountId?: number,
): UsageSnapshot {
  const d = getDb();
  const acct = accountId ?? defaultAccountId();
  const latest = d.prepare(
    `SELECT * FROM usage_snapshots WHERE profile = ? AND account_id = ? ORDER BY polled_at DESC LIMIT 1`
  ).get(profile, acct) as unknown as UsageSnapshot | undefined;

  if (latest) {
    d.prepare(
      `UPDATE usage_snapshots
       SET context_tokens = ?, context_pct = ?, context_session_id = ?,
           context_model = ?, context_effective_limit = ?, context_last_reset_at = ?
       WHERE id = ?`
    ).run(
      ctx.context_tokens,
      ctx.context_pct,
      ctx.context_session_id,
      ctx.context_model,
      ctx.context_effective_limit,
      ctx.context_last_reset_at,
      latest.id,
    );
    return d.prepare("SELECT * FROM usage_snapshots WHERE id = ?")
      .get(latest.id) as unknown as UsageSnapshot;
  }

  // No prior snapshot — insert a fresh row with only context fields populated.
  return insertSnapshot(profile, null, null, null, null, null, ctx, acct);
}

export function getLastSuccessfulSnapshot(
  profile: string,
  accountId?: number,
): UsageSnapshot | undefined {
  const d = getDb();
  const acct = accountId ?? defaultAccountId();
  const row = d.prepare(
    `SELECT * FROM usage_snapshots
     WHERE profile = ? AND account_id = ?
       AND (five_hour_resets_at IS NOT NULL OR seven_day_resets_at IS NOT NULL)
     ORDER BY polled_at DESC
     LIMIT 1`
  ).get(profile, acct);
  return row as unknown as UsageSnapshot | undefined;
}

export function getLatestSnapshot(
  profile: string,
  accountId?: number,
): UsageSnapshot | undefined {
  const d = getDb();
  const acct = accountId ?? defaultAccountId();
  const row = d.prepare(
    `SELECT * FROM usage_snapshots
     WHERE profile = ? AND account_id = ?
     ORDER BY polled_at DESC
     LIMIT 1`
  ).get(profile, acct);
  return row as unknown as UsageSnapshot | undefined;
}

export function getLatestSnapshots(accountId?: number): UsageSnapshot[] {
  const d = getDb();
  const acct = accountId ?? defaultAccountId();
  return d.prepare(
    `SELECT s.*
     FROM usage_snapshots s
     INNER JOIN (
       SELECT profile, MAX(polled_at) as max_polled
       FROM usage_snapshots
       WHERE account_id = ?
       GROUP BY profile
     ) latest ON s.profile = latest.profile AND s.polled_at = latest.max_polled
     WHERE s.account_id = ?
     ORDER BY s.profile`
  ).all(acct, acct) as unknown as UsageSnapshot[];
}

export function getHistory(
  profile: string,
  hours: number = 24,
  limit: number = 100,
  accountId?: number,
): UsageSnapshot[] {
  const d = getDb();
  const acct = accountId ?? defaultAccountId();
  return d.prepare(
    `SELECT * FROM usage_snapshots
     WHERE profile = ? AND account_id = ?
       AND polled_at >= datetime('now', '-' || ? || ' hours')
     ORDER BY polled_at DESC
     LIMIT ?`
  ).all(profile, acct, hours, limit) as unknown as UsageSnapshot[];
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

// --- Token rollup functions ---

/**
 * Upsert one (profile, host, day, model) rollup. On conflict the counts are
 * REPLACED (not summed) — the caller computes complete per-day totals from the
 * transcripts each run, so the latest computation is authoritative.
 */
export function upsertTokenRollup(row: TokenRollupInput): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO token_rollups
       (profile, host, day, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, cost_usd, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(profile, host, day, model) DO UPDATE SET
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_creation_tokens = excluded.cache_creation_tokens,
       cache_read_tokens = excluded.cache_read_tokens,
       cost_usd = excluded.cost_usd,
       source = excluded.source,
       updated_at = datetime('now')`
  ).run(
    row.profile,
    row.host,
    row.day,
    row.model,
    row.input_tokens,
    row.output_tokens,
    row.cache_creation_tokens,
    row.cache_read_tokens,
    row.cost_usd,
    row.source,
  );
}

export function getTokenRollups(opts: {
  sinceDay?: string;
  profile?: string;
  host?: string;
} = {}): TokenRollup[] {
  const d = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.sinceDay) {
    clauses.push("day >= ?");
    params.push(opts.sinceDay);
  }
  if (opts.profile) {
    clauses.push("profile = ?");
    params.push(opts.profile);
  }
  if (opts.host) {
    clauses.push("host = ?");
    params.push(opts.host);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return d
    .prepare(`SELECT * FROM token_rollups ${where} ORDER BY day DESC, profile, host, model`)
    .all(...params) as unknown as TokenRollup[];
}

function emptyReportTotals(): TokenReportTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}

function addInto(acc: TokenReportTotals, r: TokenRollup): void {
  acc.input_tokens += r.input_tokens;
  acc.output_tokens += r.output_tokens;
  acc.cache_creation_tokens += r.cache_creation_tokens;
  acc.cache_read_tokens += r.cache_read_tokens;
  acc.total_tokens +=
    r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens;
  acc.cost_usd += r.cost_usd;
}

function roundCost(t: TokenReportTotals): void {
  t.cost_usd = Math.round(t.cost_usd * 1e6) / 1e6;
}

/** Bucket a YYYY-MM-DD day to the ISO Monday of its week (for weekly granularity). */
function weekBucket(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate rollups into a per-profile report with per-host breakdown, a
 * per-bucket (day or week) time series, and a combined grand total.
 */
export function getTokenReport(opts: {
  granularity?: "daily" | "weekly";
  days?: number;
}): TokenReport {
  const granularity = opts.granularity ?? "daily";
  const days = opts.days ?? 30;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);

  const rollups = getTokenRollups({ sinceDay });

  const profileMap = new Map<
    string,
    {
      totals: TokenReportTotals;
      byDay: Map<string, TokenReportTotals>;
      byHost: Map<string, TokenReportTotals>;
    }
  >();
  const grand = emptyReportTotals();

  for (const r of rollups) {
    let p = profileMap.get(r.profile);
    if (!p) {
      p = { totals: emptyReportTotals(), byDay: new Map(), byHost: new Map() };
      profileMap.set(r.profile, p);
    }
    addInto(p.totals, r);
    addInto(grand, r);

    const bucket = granularity === "weekly" ? weekBucket(r.day) : r.day;
    let dayAcc = p.byDay.get(bucket);
    if (!dayAcc) {
      dayAcc = emptyReportTotals();
      p.byDay.set(bucket, dayAcc);
    }
    addInto(dayAcc, r);

    let hostAcc = p.byHost.get(r.host);
    if (!hostAcc) {
      hostAcc = emptyReportTotals();
      p.byHost.set(r.host, hostAcc);
    }
    addInto(hostAcc, r);
  }

  const profiles: TokenReportProfile[] = [];
  for (const [name, p] of profileMap) {
    roundCost(p.totals);
    const by_day: TokenReportDayPoint[] = [...p.byDay.entries()]
      .map(([day, t]) => {
        roundCost(t);
        return { day, ...t };
      })
      .sort((a, b) => a.day.localeCompare(b.day));
    const by_host: TokenReportHostBreakdown[] = [...p.byHost.entries()]
      .map(([host, t]) => {
        roundCost(t);
        return { host, ...t };
      })
      .sort((a, b) => b.cost_usd - a.cost_usd);
    profiles.push({ profile: name, ...p.totals, by_day, by_host });
  }
  profiles.sort((a, b) => b.cost_usd - a.cost_usd);
  roundCost(grand);

  return { granularity, days, since_day: sinceDay, profiles, total: grand };
}

// ── Ingest tokens ────────────────────────────────────────────────────────────

/**
 * Mint a new ingest token for (account, machine). Returns the plaintext (shown
 * ONCE to the caller) plus the stored row. Only the sha-256 hash is persisted.
 */
export function mintIngestToken(
  accountId: number,
  machine: string,
): { plaintext: string; token: IngestToken } {
  const d = getDb();
  const plaintext = `cp_${crypto.randomBytes(24).toString("hex")}`;
  const hash = hashIngestToken(plaintext);
  const result = d.prepare(
    `INSERT INTO ingest_tokens (account_id, machine, token_hash) VALUES (?, ?, ?)`
  ).run(accountId, machine, hash);
  const token = d.prepare("SELECT * FROM ingest_tokens WHERE id = ?")
    .get(result.lastInsertRowid) as unknown as IngestToken;
  // Ensure a machines row exists for this (account, machine).
  upsertMachine(accountId, machine);
  return { plaintext, token };
}

function maskToken(t: IngestToken): IngestTokenMasked {
  return {
    id: t.id,
    account_id: t.account_id,
    machine: t.machine,
    token_preview: `…${t.token_hash.slice(-6)}`,
    created_at: t.created_at,
    last_used_at: t.last_used_at,
    revoked_at: t.revoked_at,
  };
}

/** List an account's ingest tokens (masked — never exposes the hash plaintext). */
export function listIngestTokens(accountId: number): IngestTokenMasked[] {
  const d = getDb();
  const rows = d.prepare(
    "SELECT * FROM ingest_tokens WHERE account_id = ? ORDER BY id DESC"
  ).all(accountId) as unknown as IngestToken[];
  return rows.map(maskToken);
}

/** Revoke one ingest token by id, scoped to the account. */
export function revokeIngestToken(accountId: number, id: number): boolean {
  const d = getDb();
  const result = d.prepare(
    `UPDATE ingest_tokens SET revoked_at = datetime('now')
     WHERE id = ? AND account_id = ? AND revoked_at IS NULL`
  ).run(id, accountId);
  return Number(result.changes) > 0;
}

/**
 * Validate a presented bearer plaintext by hash lookup. Returns the token row
 * (account + machine) when valid + not revoked, and stamps last_used_at.
 */
export function validateIngestToken(plaintext: string): IngestToken | undefined {
  const d = getDb();
  const hash = hashIngestToken(plaintext);
  const row = d.prepare(
    "SELECT * FROM ingest_tokens WHERE token_hash = ? AND revoked_at IS NULL"
  ).get(hash) as unknown as IngestToken | undefined;
  if (!row) return undefined;
  d.prepare("UPDATE ingest_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

// ── Machines ─────────────────────────────────────────────────────────────────

export function upsertMachine(accountId: number, name: string): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO machines (account_id, name) VALUES (?, ?)
     ON CONFLICT(account_id, name) DO UPDATE SET last_seen = datetime('now')`
  ).run(accountId, name);
}

export function listMachines(accountId: number): MachineRow[] {
  const d = getDb();
  return d.prepare(
    "SELECT * FROM machines WHERE account_id = ? ORDER BY name"
  ).all(accountId) as unknown as MachineRow[];
}

// ── token_usage (fine grain) ─────────────────────────────────────────────────

/**
 * Upsert one fine-grained token_usage row. On conflict the counts are REPLACED
 * (the caller recomputes complete totals per run), mirroring token_rollups.
 */
export function upsertTokenUsage(row: TokenUsageInput): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO token_usage
       (account_id, profile, machine, session_id, model, settings_hash, settings_json, day,
        tokens_in, tokens_out, cache_write_5m, cache_write_1h, cache_read, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(account_id, profile, machine, session_id, model, settings_hash, day) DO UPDATE SET
       settings_json = excluded.settings_json,
       tokens_in = excluded.tokens_in,
       tokens_out = excluded.tokens_out,
       cache_write_5m = excluded.cache_write_5m,
       cache_write_1h = excluded.cache_write_1h,
       cache_read = excluded.cache_read,
       source = excluded.source,
       updated_at = datetime('now')`
  ).run(
    row.account_id,
    row.profile,
    row.machine,
    row.session_id,
    row.model,
    row.settings_hash,
    row.settings_json,
    row.day,
    row.tokens_in,
    row.tokens_out,
    row.cache_write_5m,
    row.cache_write_1h,
    row.cache_read,
    row.source,
  );
  upsertMachine(row.account_id, row.machine);
}

export function getTokenUsage(opts: {
  accountId: number;
  sinceDay?: string;
  profile?: string;
  machine?: string;
}): TokenUsageRow[] {
  const d = getDb();
  const clauses: string[] = ["account_id = ?"];
  const params: (string | number)[] = [opts.accountId];
  if (opts.sinceDay) {
    clauses.push("day >= ?");
    params.push(opts.sinceDay);
  }
  if (opts.profile) {
    clauses.push("profile = ?");
    params.push(opts.profile);
  }
  if (opts.machine) {
    clauses.push("machine = ?");
    params.push(opts.machine);
  }
  return d
    .prepare(
      `SELECT * FROM token_usage WHERE ${clauses.join(" AND ")}
       ORDER BY day DESC, profile, machine, session_id, model`
    )
    .all(...params) as unknown as TokenUsageRow[];
}

// ── context_sessions ─────────────────────────────────────────────────────────

export function upsertContextSession(row: ContextSessionInput): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO context_sessions
       (account_id, profile, machine, session_id, model, settings_json,
        context_tokens, context_pct, effective_limit, updated_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(account_id, profile, machine, session_id) DO UPDATE SET
       model = excluded.model,
       settings_json = excluded.settings_json,
       context_tokens = excluded.context_tokens,
       context_pct = excluded.context_pct,
       effective_limit = excluded.effective_limit,
       updated_at = datetime('now'),
       last_active_at = excluded.last_active_at`
  ).run(
    row.account_id,
    row.profile,
    row.machine,
    row.session_id,
    row.model,
    row.settings_json,
    row.context_tokens,
    row.context_pct,
    row.effective_limit,
    row.last_active_at,
  );
  upsertMachine(row.account_id, row.machine);
}

/** Live (non-stale) context sessions for an account, newest-active first. */
export function getActiveContextSessions(accountId: number): ContextSessionRow[] {
  const d = getDb();
  return d.prepare(
    `SELECT * FROM context_sessions
     WHERE account_id = ?
       AND last_active_at >= datetime('now', '-' || ? || ' days')
     ORDER BY profile, machine, last_active_at DESC`
  ).all(accountId, CONTEXT_STALE_DAYS) as unknown as ContextSessionRow[];
}

/** Delete context sessions whose last_active_at is older than the stale window. */
export function sweepStaleContextSessions(): number {
  const d = getDb();
  const result = d.prepare(
    `DELETE FROM context_sessions
     WHERE last_active_at < datetime('now', '-' || ? || ' days')`
  ).run(CONTEXT_STALE_DAYS);
  return Number(result.changes);
}

// ── Pricing ──────────────────────────────────────────────────────────────────

export function getPricingDefaults(): PricingRow[] {
  const d = getDb();
  return d.prepare(
    "SELECT model, settings_match_json, input, output, cache_write_5m, cache_write_1h, cache_read, source_url, as_of FROM pricing_defaults"
  ).all() as unknown as PricingRow[];
}

export function getPricingOverrides(accountId: number): PricingOverrideRow[] {
  const d = getDb();
  return d.prepare(
    "SELECT model, settings_match_json, input, output, cache_write_5m, cache_write_1h, cache_read FROM pricing_overrides WHERE account_id = ?"
  ).all(accountId) as unknown as PricingOverrideRow[];
}

export function upsertPricingOverride(accountId: number, row: PricingOverrideRow): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO pricing_overrides
       (account_id, model, settings_match_json, input, output, cache_write_5m, cache_write_1h, cache_read, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(account_id, model, settings_match_json) DO UPDATE SET
       input = excluded.input,
       output = excluded.output,
       cache_write_5m = excluded.cache_write_5m,
       cache_write_1h = excluded.cache_write_1h,
       cache_read = excluded.cache_read,
       updated_at = datetime('now')`
  ).run(
    accountId,
    row.model,
    row.settings_match_json,
    row.input,
    row.output,
    row.cache_write_5m,
    row.cache_write_1h,
    row.cache_read,
  );
}

/** Delete all overrides for a model (reset to default). Returns rows removed. */
export function deletePricingOverride(accountId: number, model: string): number {
  const d = getDb();
  const result = d.prepare(
    "DELETE FROM pricing_overrides WHERE account_id = ? AND model = ?"
  ).run(accountId, model);
  return Number(result.changes);
}

// ── Fine-grained token report (token_usage) ──────────────────────────────────

function emptyReport(): ReportTotals {
  return {
    tokens_in: 0,
    tokens_out: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}

function addRowInto(acc: ReportTotals, r: TokenUsageRow, cost: number): void {
  acc.tokens_in += r.tokens_in;
  acc.tokens_out += r.tokens_out;
  acc.cache_write_5m += r.cache_write_5m;
  acc.cache_write_1h += r.cache_write_1h;
  acc.cache_read += r.cache_read;
  acc.total_tokens +=
    r.tokens_in + r.tokens_out + r.cache_write_5m + r.cache_write_1h + r.cache_read;
  acc.cost_usd += cost;
}

function roundReport(t: ReportTotals): void {
  t.cost_usd = Math.round(t.cost_usd * 1e6) / 1e6;
}

function drillKeyFor(r: TokenUsageRow, drill: ReportDrill): string {
  switch (drill) {
    case "machine":
      return r.machine;
    case "session":
      return r.session_id;
    case "model":
      return r.model;
    default:
      return r.profile;
  }
}

/**
 * Aggregate token_usage into an account-scoped report. Default rollup is
 * session-agnostic to (account, profile) with by_machine + by_day; `drill`
 * adds a per-(machine|session|model) breakdown within each profile. Cost is
 * recomputed from token grains × the account's effective per-(model,settings)
 * rate so editing rates re-prices history.
 */
export function getFineTokenReport(opts: {
  accountId: number;
  identity: string;
  granularity?: "daily" | "weekly";
  days?: number;
  drill?: ReportDrill;
  profile?: string;
  machine?: string;
}): FineTokenReport {
  const granularity = opts.granularity ?? "daily";
  const days = opts.days ?? 30;
  const drill = opts.drill ?? "profile";
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);

  const rows = getTokenUsage({
    accountId: opts.accountId,
    sinceDay,
    profile: opts.profile,
    machine: opts.machine,
  });

  const defaults = getPricingDefaults();
  const overrides = getPricingOverrides(opts.accountId);

  const profileMap = new Map<
    string,
    {
      totals: ReportTotals;
      byDay: Map<string, ReportTotals>;
      byMachine: Map<string, ReportTotals>;
      drill: Map<string, ReportTotals>;
    }
  >();
  const grand = emptyReport();

  for (const r of rows) {
    let settings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.settings_json);
      if (parsed && typeof parsed === "object") settings = parsed;
    } catch {
      /* ignore malformed */
    }
    const { rate } = resolveRate(r.model, settings, defaults, overrides);
    const cost = costForGrain(
      {
        tokens_in: r.tokens_in,
        tokens_out: r.tokens_out,
        cache_write_5m: r.cache_write_5m,
        cache_write_1h: r.cache_write_1h,
        cache_read: r.cache_read,
      },
      rate,
    );

    let p = profileMap.get(r.profile);
    if (!p) {
      p = { totals: emptyReport(), byDay: new Map(), byMachine: new Map(), drill: new Map() };
      profileMap.set(r.profile, p);
    }
    addRowInto(p.totals, r, cost);
    addRowInto(grand, r, cost);

    const bucket = granularity === "weekly" ? weekBucket(r.day) : r.day;
    let dayAcc = p.byDay.get(bucket);
    if (!dayAcc) { dayAcc = emptyReport(); p.byDay.set(bucket, dayAcc); }
    addRowInto(dayAcc, r, cost);

    let machAcc = p.byMachine.get(r.machine);
    if (!machAcc) { machAcc = emptyReport(); p.byMachine.set(r.machine, machAcc); }
    addRowInto(machAcc, r, cost);

    if (drill === "machine" || drill === "session" || drill === "model") {
      const dk = drillKeyFor(r, drill);
      let dAcc = p.drill.get(dk);
      if (!dAcc) { dAcc = emptyReport(); p.drill.set(dk, dAcc); }
      addRowInto(dAcc, r, cost);
    }
  }

  const profiles: ReportProfileGroup[] = [];
  for (const [name, p] of profileMap) {
    roundReport(p.totals);
    const by_day: ReportDayPoint[] = [...p.byDay.entries()]
      .map(([day, t]) => { roundReport(t); return { day, ...t }; })
      .sort((a, b) => a.day.localeCompare(b.day));
    const by_machine: ReportBreakdown[] = [...p.byMachine.entries()]
      .map(([key, t]) => { roundReport(t); return { key, ...t }; })
      .sort((a, b) => b.cost_usd - a.cost_usd);
    const group: ReportProfileGroup = { profile: name, ...p.totals, by_machine, by_day };
    if (drill === "machine" || drill === "session" || drill === "model") {
      group.drill = [...p.drill.entries()]
        .map(([key, t]) => { roundReport(t); return { key, ...t }; })
        .sort((a, b) => b.cost_usd - a.cost_usd);
    }
    profiles.push(group);
  }
  profiles.sort((a, b) => b.cost_usd - a.cost_usd);
  roundReport(grand);

  return {
    granularity,
    days,
    since_day: sinceDay,
    drill,
    account: opts.identity,
    profiles,
    total: grand,
  };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined!;
  }
}
