import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  type Backend,
  type Dialect,
  createSqliteBackend,
  createPgBackend,
  pgConfigFromEnv,
} from "./db.js";
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

let backend: Backend | undefined;

/** The active dialect, for the few places that branch on it. */
function dialect(): Dialect {
  return getDb().dialect;
}

/**
 * A `datetime('now', '-' || ? || ' hours')` SQLite expression has no direct
 * `?`-translatable Postgres equivalent (interval string concat). This helper
 * emits the right per-dialect SQL fragment for "now minus N <unit>", binding N
 * as a parameter on both backends.
 *
 * SQLite:   datetime('now', '-' || ? || ' hours')
 * Postgres: (now()::timestamptz - ($n || ' hours')::interval)
 *
 * The caller still pushes the numeric N into its params array in order.
 */
function nowMinus(unit: "hours" | "days"): string {
  if (dialect() === "postgres") {
    return `(now()::timestamptz - (? || ' ${unit}')::interval)`;
  }
  return `datetime('now', '-' || ? || ' ${unit}')`;
}

/**
 * Initialize the database. Optionally pass a custom dbPath (SQLite) for testing.
 *
 * Backend selection:
 *   - Postgres when `CLAUDE_PULSE_PG_URL` (or the discrete `CLAUDE_PULSE_PG_*`
 *     vars) is set. `dbPath` is ignored in that case.
 *   - SQLite otherwise (default). Uses `dbPath` or `~/.claude-pulse/usage.db`.
 *
 * Tests can force a backend by passing an explicit `opts.backend`.
 */
export async function initDb(
  dbPath?: string,
  opts?: { backend?: Backend },
): Promise<void> {
  if (backend) return;

  if (opts?.backend) {
    backend = opts.backend;
  } else if (pgConfigFromEnv()) {
    backend = await createPgBackend();
  } else {
    const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
    const resolvedDir = path.dirname(resolvedPath);
    fs.mkdirSync(resolvedDir, { recursive: true });
    const sqlite = new DatabaseSync(resolvedPath);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA foreign_keys = ON");
    backend = createSqliteBackend(sqlite);
  }

  await createSchema(backend);
}

function getDb(): Backend {
  if (!backend) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return backend;
}

// ── Schema creation + migrations ─────────────────────────────────────────────

/** Identity-column DDL fragment for the active dialect. */
function idColumn(d: Dialect): string {
  return d === "postgres"
    ? "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
    : "id INTEGER PRIMARY KEY AUTOINCREMENT";
}

/** `datetime('now')` default works on SQLite; Postgres uses now(). Both store TEXT. */
function nowDefault(d: Dialect): string {
  return d === "postgres" ? "now()" : "(datetime('now'))";
}

async function createSchema(db: Backend): Promise<void> {
  const d = db.dialect;
  const ID = idColumn(d);
  const NOW = nowDefault(d);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      name TEXT PRIMARY KEY,
      config_dir TEXT NOT NULL,
      poll_interval_minutes INTEGER NOT NULL DEFAULT 5,
      vendor TEXT NOT NULL DEFAULT 'anthropic-oauth',
      monthly_budget_usd ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"},
      api_key TEXT,
      account_id INTEGER,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    )
  `);

  // Migrate older SQLite DBs that pre-date the vendor/budget/api_key/account_id
  // columns. (Fresh Postgres DBs always have them, so this only runs on SQLite.)
  if (d === "sqlite") {
    const cols = (await db.all<{ name: string }>("PRAGMA table_info(profiles)")).map((c) => c.name);
    if (!cols.includes("vendor")) {
      await db.exec("ALTER TABLE profiles ADD COLUMN vendor TEXT NOT NULL DEFAULT 'anthropic-oauth'");
    }
    if (!cols.includes("monthly_budget_usd")) {
      await db.exec("ALTER TABLE profiles ADD COLUMN monthly_budget_usd REAL");
    }
    if (!cols.includes("api_key")) {
      await db.exec("ALTER TABLE profiles ADD COLUMN api_key TEXT");
    }
    if (!cols.includes("account_id")) {
      await db.exec("ALTER TABLE profiles ADD COLUMN account_id INTEGER");
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      ${ID},
      profile TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
      five_hour_pct ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"},
      five_hour_resets_at TEXT,
      seven_day_pct ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"},
      seven_day_resets_at TEXT,
      raw_response TEXT,
      polled_at TEXT NOT NULL DEFAULT ${NOW},
      context_tokens INTEGER,
      context_pct ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"},
      context_session_id TEXT,
      context_model TEXT,
      context_effective_limit INTEGER,
      context_last_reset_at TEXT
    )
  `);

  if (d === "sqlite") {
    const snapCols = (await db.all<{ name: string }>("PRAGMA table_info(usage_snapshots)")).map((c) => c.name);
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
        await db.exec(`ALTER TABLE usage_snapshots ADD COLUMN ${c}`);
      }
    }
  } else {
    // Postgres fresh schema doesn't carry account_id in the CREATE above (kept
    // identical to SQLite's historical shape); add it explicitly.
    await db.exec("ALTER TABLE usage_snapshots ADD COLUMN IF NOT EXISTS account_id INTEGER");
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_snapshots_profile_time
      ON usage_snapshots(profile, polled_at)
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS gemini_quota (
      ${ID},
      timestamp TEXT NOT NULL DEFAULT ${NOW},
      model_id TEXT NOT NULL,
      remaining_fraction ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      remaining_amount TEXT,
      reset_time TEXT
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gemini_quota_model_time
      ON gemini_quota(model_id, timestamp)
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      ${ID},
      account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      profile TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
      alert_type TEXT NOT NULL CHECK(alert_type IN ('five_hour_threshold', 'seven_day_threshold', 'auth_failure', 'context_threshold')),
      threshold ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"},
      channel TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 30,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    )
  `);

  if (d === "sqlite") {
    await migrateAlertSubscriptionsSqlite(db);
    const subCols = (await db.all<{ name: string }>("PRAGMA table_info(alert_subscriptions)")).map((c) => c.name);
    if (subCols.length > 0 && !subCols.includes("account_id")) {
      await db.exec("ALTER TABLE alert_subscriptions ADD COLUMN account_id INTEGER");
    }
  }

  // Subscriptions are unique per (account, profile, alert_type, threshold).
  // COALESCE folds NULL threshold (auth_failure) to a sentinel. An earlier build
  // created this WITHOUT threshold — drop that older form first.
  await db.exec(`DROP INDEX IF EXISTS idx_alert_subs_unique`);
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_subs_unique
      ON alert_subscriptions(account_id, profile, alert_type, COALESCE(threshold, -1))
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      ${ID},
      account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      subscription_id INTEGER NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
      profile TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      current_value ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"},
      threshold ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"},
      acknowledged INTEGER NOT NULL DEFAULT 0,
      triggered_at TEXT NOT NULL DEFAULT ${NOW}
    )
  `);

  if (d === "sqlite") {
    const aeCols = (await db.all<{ name: string }>("PRAGMA table_info(alert_events)")).map((c) => c.name);
    if (aeCols.length > 0 && !aeCols.includes("account_id")) {
      await db.exec("ALTER TABLE alert_events ADD COLUMN account_id INTEGER");
    }
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_events_sub
      ON alert_events(subscription_id, triggered_at)
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_events_account
      ON alert_events(account_id, triggered_at)
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS token_rollups (
      ${ID},
      profile TEXT NOT NULL,
      host TEXT NOT NULL,
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'local',
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE(profile, host, day, model)
    )
  `);

  if (d === "sqlite") {
    const trCols = (await db.all<{ name: string }>("PRAGMA table_info(token_rollups)")).map((c) => c.name);
    if (trCols.length > 0 && !trCols.includes("source")) {
      await db.exec("ALTER TABLE token_rollups ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
    }
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_rollups_day
      ON token_rollups(day, profile)
  `);

  // ── Multi-tenant tables ────────────────────────────────────────────────────

  await db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      ${ID},
      identity TEXT NOT NULL UNIQUE,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    )
  `);

  // Seed the default/local account so single-tenant DBs + fallback always work.
  await db.run(
    `INSERT INTO accounts (identity, display_name) VALUES (?, ?)
     ON CONFLICT(identity) DO NOTHING`,
    [DEFAULT_ACCOUNT_IDENTITY, DEFAULT_ACCOUNT_IDENTITY],
  );

  const defaultAcct = (await db.get<{ id: number }>(
    "SELECT id FROM accounts WHERE identity = ?",
    [DEFAULT_ACCOUNT_IDENTITY],
  ))!;

  // Backfill account_id → the default/local account on tables that gained it.
  await db.run("UPDATE usage_snapshots SET account_id = ? WHERE account_id IS NULL", [defaultAcct.id]);
  await db.run("UPDATE profiles SET account_id = ? WHERE account_id IS NULL", [defaultAcct.id]);
  await db.run("UPDATE alert_subscriptions SET account_id = ? WHERE account_id IS NULL", [defaultAcct.id]);
  await db.run("UPDATE alert_events SET account_id = ? WHERE account_id IS NULL", [defaultAcct.id]);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_tokens (
      ${ID},
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      machine TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      last_used_at TEXT,
      revoked_at TEXT
    )
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ingest_tokens_account
      ON ingest_tokens(account_id, machine)
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT ${NOW},
      last_seen TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE(account_id, name)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      ${ID},
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
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE(account_id, profile, machine, session_id, model, settings_hash, day)
    )
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_report
      ON token_usage(account_id, day, profile)
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS context_sessions (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      profile TEXT NOT NULL,
      machine TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      context_tokens INTEGER,
      context_pct ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"},
      effective_limit INTEGER,
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      last_active_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE(account_id, profile, machine, session_id)
    )
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_sessions_active
      ON context_sessions(account_id, last_active_at)
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_defaults (
      model TEXT NOT NULL,
      settings_match_json TEXT NOT NULL DEFAULT '{}',
      input ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      output ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      cache_write_5m ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      cache_write_1h ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      cache_read ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      source_url TEXT,
      as_of TEXT,
      UNIQUE(model, settings_match_json)
    )
  `);

  // Seed/refresh the placeholder default pricing rows (idempotent upsert).
  for (const r of DEFAULT_PRICING) {
    await db.run(
      `INSERT INTO pricing_defaults
         (model, settings_match_json, input, output, cache_write_5m, cache_write_1h, cache_read, source_url, as_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model, settings_match_json) DO NOTHING`,
      [
        r.model,
        r.settings_match_json,
        r.input,
        r.output,
        r.cache_write_5m,
        r.cache_write_1h,
        r.cache_read,
        r.source_url ?? null,
        r.as_of ?? null,
      ],
    );
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_overrides (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      settings_match_json TEXT NOT NULL DEFAULT '{}',
      input ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      output ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      cache_write_5m ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      cache_write_1h ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      cache_read ${d === "postgres" ? "DOUBLE PRECISION" : "REAL"} NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE(account_id, model, settings_match_json)
    )
  `);
}

/**
 * SQLite-only: older DBs created alert_subscriptions with a CHECK constraint that
 * blocked 'context_threshold'. SQLite can't ALTER a CHECK in place, so detect +
 * rebuild only when needed, inside an exclusive transaction.
 */
async function migrateAlertSubscriptionsSqlite(db: Backend): Promise<void> {
  try {
    const tableSql = (await db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='alert_subscriptions'",
    ))?.sql ?? "";
    if (tableSql && !tableSql.includes("context_threshold")) {
      await db.exec("BEGIN IMMEDIATE");
      const recheckSql = (await db.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='alert_subscriptions'",
      ))?.sql ?? "";
      if (!recheckSql.includes("context_threshold")) {
        await db.exec(`DROP TABLE IF EXISTS alert_subscriptions__new`);
        await db.exec(`
          CREATE TABLE alert_subscriptions__new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
            profile TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
            alert_type TEXT NOT NULL CHECK(alert_type IN ('five_hour_threshold', 'seven_day_threshold', 'auth_failure', 'context_threshold')),
            threshold REAL,
            channel TEXT,
            cooldown_minutes INTEGER NOT NULL DEFAULT 30,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        await db.exec(`
          INSERT INTO alert_subscriptions__new
            (id, profile, alert_type, threshold, channel, cooldown_minutes, enabled, created_at)
          SELECT id, profile, alert_type, threshold, channel, cooldown_minutes, enabled, created_at
          FROM alert_subscriptions
        `);
        await db.exec(`DROP TABLE alert_subscriptions`);
        await db.exec(`ALTER TABLE alert_subscriptions__new RENAME TO alert_subscriptions`);
      }
      await db.exec("COMMIT");
    }
  } catch (e) {
    try { await db.exec("ROLLBACK"); } catch { /* noop */ }
    process.stderr.write(`[claude-pulse] alert_subscriptions migration warning: ${(e as Error).message}\n`);
  }
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** Get an account by identity, or undefined. */
export async function getAccount(identity: string): Promise<Account | undefined> {
  const d = getDb();
  return d.get<Account>("SELECT * FROM accounts WHERE identity = ?", [identity]);
}

export async function getAccountById(id: number): Promise<Account | undefined> {
  const d = getDb();
  return d.get<Account>("SELECT * FROM accounts WHERE id = ?", [id]);
}

/**
 * Resolve (auto-create on first sight) the account for an identity. Pass the
 * `X-Auth-Request-Email` value, or undefined/null to use the default account.
 */
export async function resolveAccount(identity?: string | null): Promise<Account> {
  const d = getDb();
  const id = (identity && identity.trim()) || DEFAULT_ACCOUNT_IDENTITY;
  const existing = await getAccount(id);
  if (existing) return existing;
  await d.run(
    `INSERT INTO accounts (identity, display_name) VALUES (?, ?)
     ON CONFLICT(identity) DO NOTHING`,
    [id, id],
  );
  return (await getAccount(id))!;
}

export async function listAccounts(): Promise<Account[]> {
  const d = getDb();
  return d.all<Account>("SELECT * FROM accounts ORDER BY id");
}

async function defaultAccountId(): Promise<number> {
  return (await resolveAccount(DEFAULT_ACCOUNT_IDENTITY)).id;
}

/** Public accessor for the local/default daemon account id. */
export async function localAccountId(): Promise<number> {
  return defaultAccountId();
}

export async function ensureDefaultProfiles(accountId?: number): Promise<void> {
  const d = getDb();
  const homeDir = os.homedir();
  const acct = accountId ?? (await defaultAccountId());

  const defaults = [
    { name: "claude-hd", config_dir: path.join(homeDir, ".claude-hd") },
    { name: "claude-max", config_dir: path.join(homeDir, ".claude-max") },
  ];

  for (const p of defaults) {
    await d.run(
      `INSERT INTO profiles (name, config_dir, poll_interval_minutes, account_id)
       VALUES (?, ?, 5, ?)
       ON CONFLICT(name) DO NOTHING`,
      [p.name, p.config_dir, acct],
    );
  }
}

/** List profiles for an account (defaults to the local daemon's account). */
export async function listProfiles(accountId?: number): Promise<Profile[]> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  return d.all<Profile>("SELECT * FROM profiles WHERE account_id = ? ORDER BY name", [acct]);
}

export function redactProfile(p: Profile): Omit<Profile, "api_key"> & { api_key: string | null } {
  return { ...p, api_key: p.api_key ? "***" : null };
}

export async function getProfile(name: string, accountId?: number): Promise<Profile | undefined> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  return d.get<Profile>("SELECT * FROM profiles WHERE name = ? AND account_id = ?", [name, acct]);
}

export async function addProfile(
  name: string,
  configDir: string,
  pollIntervalMinutes: number = 5,
  vendor: ProfileVendor = "anthropic-oauth",
  monthlyBudgetUsd: number | null = null,
  apiKey: string | null = null,
  accountId?: number,
): Promise<Profile> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  await d.run(
    `INSERT INTO profiles (name, config_dir, poll_interval_minutes, vendor, monthly_budget_usd, api_key, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, configDir, pollIntervalMinutes, vendor, monthlyBudgetUsd, apiKey, acct],
  );
  return (await getProfile(name, acct))!;
}

export async function updateProfileBudget(
  name: string,
  monthlyBudgetUsd: number | null,
): Promise<boolean> {
  const d = getDb();
  const result = await d.run(
    `UPDATE profiles
     SET monthly_budget_usd = ?, updated_at = datetime('now')
     WHERE name = ?`,
    [monthlyBudgetUsd, name],
  );
  return result.changes > 0;
}

export async function updateProfileApiKey(
  name: string,
  apiKey: string | null,
): Promise<boolean> {
  const d = getDb();
  const result = await d.run(
    `UPDATE profiles
     SET api_key = ?, updated_at = datetime('now')
     WHERE name = ?`,
    [apiKey, name],
  );
  return result.changes > 0;
}

export async function removeProfile(name: string): Promise<boolean> {
  const d = getDb();
  // Delete snapshots first (even though CASCADE should handle it)
  await d.run("DELETE FROM usage_snapshots WHERE profile = ?", [name]);
  const result = await d.run("DELETE FROM profiles WHERE name = ?", [name]);
  return result.changes > 0;
}

export async function updatePollInterval(
  name: string,
  intervalMinutes: number,
): Promise<boolean> {
  const d = getDb();
  const result = await d.run(
    `UPDATE profiles
     SET poll_interval_minutes = ?, updated_at = datetime('now')
     WHERE name = ?`,
    [intervalMinutes, name],
  );
  return result.changes > 0;
}

export interface ContextSnapshotFields {
  context_tokens: number | null;
  context_pct: number | null;
  context_session_id: string | null;
  context_model: string | null;
  context_effective_limit: number | null;
  context_last_reset_at: string | null;
}

export async function insertSnapshot(
  profile: string,
  fiveHourPct: number | null,
  fiveHourResetsAt: string | null,
  sevenDayPct: number | null,
  sevenDayResetsAt: string | null,
  rawResponse: string | null,
  ctx?: ContextSnapshotFields | null,
  accountId?: number,
): Promise<UsageSnapshot> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  const id = await d.insertReturningId(
    `INSERT INTO usage_snapshots
       (account_id, profile, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, raw_response,
        context_tokens, context_pct, context_session_id, context_model, context_effective_limit, context_last_reset_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
  );

  return (await d.get<UsageSnapshot>("SELECT * FROM usage_snapshots WHERE id = ?", [id]))!;
}

/**
 * Update only the context-* fields on the most recent snapshot for a profile,
 * or insert a synthetic snapshot if none exists. Used by the standalone
 * context poller which runs on its own cadence.
 */
export async function upsertContextOnLatestSnapshot(
  profile: string,
  ctx: ContextSnapshotFields,
  accountId?: number,
): Promise<UsageSnapshot> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  const latest = await d.get<UsageSnapshot>(
    `SELECT * FROM usage_snapshots WHERE profile = ? AND account_id = ? ORDER BY polled_at DESC LIMIT 1`,
    [profile, acct],
  );

  if (latest) {
    await d.run(
      `UPDATE usage_snapshots
       SET context_tokens = ?, context_pct = ?, context_session_id = ?,
           context_model = ?, context_effective_limit = ?, context_last_reset_at = ?
       WHERE id = ?`,
      [
        ctx.context_tokens,
        ctx.context_pct,
        ctx.context_session_id,
        ctx.context_model,
        ctx.context_effective_limit,
        ctx.context_last_reset_at,
        latest.id,
      ],
    );
    return (await d.get<UsageSnapshot>("SELECT * FROM usage_snapshots WHERE id = ?", [latest.id]))!;
  }

  // No prior snapshot — insert a fresh row with only context fields populated.
  return insertSnapshot(profile, null, null, null, null, null, ctx, acct);
}

export async function getLastSuccessfulSnapshot(
  profile: string,
  accountId?: number,
): Promise<UsageSnapshot | undefined> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  return d.get<UsageSnapshot>(
    `SELECT * FROM usage_snapshots
     WHERE profile = ? AND account_id = ?
       AND (five_hour_resets_at IS NOT NULL OR seven_day_resets_at IS NOT NULL)
     ORDER BY polled_at DESC
     LIMIT 1`,
    [profile, acct],
  );
}

export async function getLatestSnapshot(
  profile: string,
  accountId?: number,
): Promise<UsageSnapshot | undefined> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  return d.get<UsageSnapshot>(
    `SELECT * FROM usage_snapshots
     WHERE profile = ? AND account_id = ?
     ORDER BY polled_at DESC
     LIMIT 1`,
    [profile, acct],
  );
}

export async function getLatestSnapshots(accountId?: number): Promise<UsageSnapshot[]> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  return d.all<UsageSnapshot>(
    `SELECT s.*
     FROM usage_snapshots s
     INNER JOIN (
       SELECT profile, MAX(polled_at) as max_polled
       FROM usage_snapshots
       WHERE account_id = ?
       GROUP BY profile
     ) latest ON s.profile = latest.profile AND s.polled_at = latest.max_polled
     WHERE s.account_id = ?
     ORDER BY s.profile`,
    [acct, acct],
  );
}

export async function getHistory(
  profile: string,
  hours: number = 24,
  limit: number = 100,
  accountId?: number,
): Promise<UsageSnapshot[]> {
  const d = getDb();
  const acct = accountId ?? (await defaultAccountId());
  return d.all<UsageSnapshot>(
    `SELECT * FROM usage_snapshots
     WHERE profile = ? AND account_id = ?
       AND polled_at >= ${nowMinus("hours")}
     ORDER BY polled_at DESC
     LIMIT ?`,
    [profile, acct, hours, limit],
  );
}

// --- Gemini quota functions ---

export async function insertGeminiQuotaSnapshots(
  buckets: {
    modelId: string;
    remainingFraction: number;
    remainingAmount: string | null;
    resetTime: string | null;
  }[],
): Promise<GeminiQuotaSnapshot[]> {
  if (buckets.length === 0) return [];

  const d = getDb();
  const rows: GeminiQuotaSnapshot[] = [];

  await d.transaction(async (tx) => {
    for (const bucket of buckets) {
      const id = await tx.insertReturningId(
        `INSERT INTO gemini_quota
           (model_id, remaining_fraction, remaining_amount, reset_time)
         VALUES (?, ?, ?, ?)`,
        [bucket.modelId, bucket.remainingFraction, bucket.remainingAmount, bucket.resetTime],
      );
      rows.push((await tx.get<GeminiQuotaSnapshot>("SELECT * FROM gemini_quota WHERE id = ?", [id]))!);
    }
  });

  return rows;
}

export async function getLatestGeminiQuota(): Promise<GeminiQuotaSnapshot[]> {
  const d = getDb();
  return d.all<GeminiQuotaSnapshot>(
    `SELECT *
     FROM gemini_quota
     WHERE id IN (
       SELECT MAX(id)
       FROM gemini_quota
       GROUP BY model_id
     )
     ORDER BY model_id`,
  );
}

// --- Alert Subscription functions ---

export async function createAlertSubscription(
  accountId: number,
  profile: string,
  alertType: AlertType,
  threshold: number | null,
  channel: string | null,
  cooldownMinutes: number = 30,
): Promise<AlertSubscription> {
  const d = getDb();
  const id = await d.insertReturningId(
    `INSERT INTO alert_subscriptions (account_id, profile, alert_type, threshold, channel, cooldown_minutes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [accountId, profile, alertType, threshold, channel, cooldownMinutes],
  );
  return (await d.get<AlertSubscription>("SELECT * FROM alert_subscriptions WHERE id = ?", [id]))!;
}

/**
 * Remove a subscription by id, scoped to the owning account. Returns false when
 * the row doesn't exist OR belongs to another account (closes the IDOR).
 */
export async function removeAlertSubscription(accountId: number, id: number): Promise<boolean> {
  const d = getDb();
  const result = await d.run(
    "DELETE FROM alert_subscriptions WHERE id = ? AND account_id = ?",
    [id, accountId],
  );
  return result.changes > 0;
}

export async function listAlertSubscriptions(accountId: number, profile?: string): Promise<AlertSubscription[]> {
  const d = getDb();
  if (profile) {
    return d.all<AlertSubscription>(
      "SELECT * FROM alert_subscriptions WHERE account_id = ? AND profile = ? ORDER BY id",
      [accountId, profile],
    );
  }
  return d.all<AlertSubscription>(
    "SELECT * FROM alert_subscriptions WHERE account_id = ? ORDER BY profile, id",
    [accountId],
  );
}

export async function getAlertSubscription(id: number, accountId?: number): Promise<AlertSubscription | undefined> {
  const d = getDb();
  if (accountId !== undefined) {
    return d.get<AlertSubscription>(
      "SELECT * FROM alert_subscriptions WHERE id = ? AND account_id = ?",
      [id, accountId],
    );
  }
  return d.get<AlertSubscription>("SELECT * FROM alert_subscriptions WHERE id = ?", [id]);
}

/**
 * Enabled subscriptions for a (account, profile) pair. The alert-firing path
 * passes the owning account so a fired alert is attributed correctly.
 */
export async function getEnabledAlertSubscriptions(accountId: number, profile: string): Promise<AlertSubscription[]> {
  const d = getDb();
  return d.all<AlertSubscription>(
    "SELECT * FROM alert_subscriptions WHERE account_id = ? AND profile = ? AND enabled = 1 ORDER BY id",
    [accountId, profile],
  );
}

// --- Alert Event functions ---

export async function createAlertEvent(
  accountId: number,
  subscriptionId: number,
  profile: string,
  alertType: AlertType,
  message: string,
  currentValue: number | null,
  threshold: number | null,
): Promise<AlertEvent> {
  const d = getDb();
  const id = await d.insertReturningId(
    `INSERT INTO alert_events (account_id, subscription_id, profile, alert_type, message, current_value, threshold)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [accountId, subscriptionId, profile, alertType, message, currentValue, threshold],
  );
  return (await d.get<AlertEvent>("SELECT * FROM alert_events WHERE id = ?", [id]))!;
}

export async function getTriggeredAlerts(
  accountId: number,
  profile?: string,
  sinceHours: number = 24,
  unacknowledgedOnly: boolean = false,
): Promise<AlertEvent[]> {
  const d = getDb();
  let sql = `SELECT * FROM alert_events
     WHERE account_id = ?
       AND triggered_at >= ${nowMinus("hours")}`;
  const params: (string | number)[] = [accountId, sinceHours];

  if (profile) {
    sql += " AND profile = ?";
    params.push(profile);
  }
  if (unacknowledgedOnly) {
    sql += " AND acknowledged = 0";
  }
  sql += " ORDER BY triggered_at DESC";

  return d.all<AlertEvent>(sql, params);
}

/**
 * Acknowledge one alert event by id, scoped to the owning account. Returns false
 * when the row doesn't exist OR belongs to another account (closes the IDOR).
 */
export async function acknowledgeAlert(accountId: number, eventId: number): Promise<boolean> {
  const d = getDb();
  const result = await d.run(
    "UPDATE alert_events SET acknowledged = 1 WHERE id = ? AND account_id = ? AND acknowledged = 0",
    [eventId, accountId],
  );
  return result.changes > 0;
}

export async function acknowledgeAllAlerts(accountId: number, profile?: string): Promise<number> {
  const d = getDb();
  if (profile) {
    const result = await d.run(
      "UPDATE alert_events SET acknowledged = 1 WHERE account_id = ? AND profile = ? AND acknowledged = 0",
      [accountId, profile],
    );
    return result.changes;
  }
  const result = await d.run(
    "UPDATE alert_events SET acknowledged = 1 WHERE account_id = ? AND acknowledged = 0",
    [accountId],
  );
  return result.changes;
}

export async function getLastAlertEvent(subscriptionId: number): Promise<AlertEvent | undefined> {
  const d = getDb();
  return d.get<AlertEvent>(
    `SELECT * FROM alert_events
     WHERE subscription_id = ?
     ORDER BY triggered_at DESC
     LIMIT 1`,
    [subscriptionId],
  );
}

// --- Token rollup functions ---

/**
 * Upsert one (profile, host, day, model) rollup. On conflict the counts are
 * REPLACED (not summed) — the caller computes complete per-day totals from the
 * transcripts each run, so the latest computation is authoritative.
 */
export async function upsertTokenRollup(row: TokenRollupInput): Promise<void> {
  const d = getDb();
  await d.run(
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
       updated_at = datetime('now')`,
    [
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
    ],
  );
}

export async function getTokenRollups(opts: {
  sinceDay?: string;
  profile?: string;
  host?: string;
} = {}): Promise<TokenRollup[]> {
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
  return d.all<TokenRollup>(
    `SELECT * FROM token_rollups ${where} ORDER BY day DESC, profile, host, model`,
    params,
  );
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
export async function getTokenReport(opts: {
  granularity?: "daily" | "weekly";
  days?: number;
}): Promise<TokenReport> {
  const granularity = opts.granularity ?? "daily";
  const days = opts.days ?? 30;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);

  const rollups = await getTokenRollups({ sinceDay });

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
export async function mintIngestToken(
  accountId: number,
  machine: string,
): Promise<{ plaintext: string; token: IngestToken }> {
  const d = getDb();
  const plaintext = `cp_${crypto.randomBytes(24).toString("hex")}`;
  const hash = hashIngestToken(plaintext);
  const id = await d.insertReturningId(
    `INSERT INTO ingest_tokens (account_id, machine, token_hash) VALUES (?, ?, ?)`,
    [accountId, machine, hash],
  );
  const token = (await d.get<IngestToken>("SELECT * FROM ingest_tokens WHERE id = ?", [id]))!;
  // Ensure a machines row exists for this (account, machine).
  await upsertMachine(accountId, machine);
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
export async function listIngestTokens(accountId: number): Promise<IngestTokenMasked[]> {
  const d = getDb();
  const rows = await d.all<IngestToken>(
    "SELECT * FROM ingest_tokens WHERE account_id = ? ORDER BY id DESC",
    [accountId],
  );
  return rows.map(maskToken);
}

/** Revoke one ingest token by id, scoped to the account. */
export async function revokeIngestToken(accountId: number, id: number): Promise<boolean> {
  const d = getDb();
  const result = await d.run(
    `UPDATE ingest_tokens SET revoked_at = datetime('now')
     WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
    [id, accountId],
  );
  return result.changes > 0;
}

/**
 * Validate a presented bearer plaintext by hash lookup. Returns the token row
 * (account + machine) when valid + not revoked, and stamps last_used_at.
 */
export async function validateIngestToken(plaintext: string): Promise<IngestToken | undefined> {
  const d = getDb();
  const hash = hashIngestToken(plaintext);
  const row = await d.get<IngestToken>(
    "SELECT * FROM ingest_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    [hash],
  );
  if (!row) return undefined;
  await d.run("UPDATE ingest_tokens SET last_used_at = datetime('now') WHERE id = ?", [row.id]);
  return row;
}

// ── Machines ─────────────────────────────────────────────────────────────────

export async function upsertMachine(accountId: number, name: string): Promise<void> {
  const d = getDb();
  await d.run(
    `INSERT INTO machines (account_id, name) VALUES (?, ?)
     ON CONFLICT(account_id, name) DO UPDATE SET last_seen = datetime('now')`,
    [accountId, name],
  );
}

export async function listMachines(accountId: number): Promise<MachineRow[]> {
  const d = getDb();
  return d.all<MachineRow>("SELECT * FROM machines WHERE account_id = ? ORDER BY name", [accountId]);
}

// ── token_usage (fine grain) ─────────────────────────────────────────────────

/**
 * Upsert one fine-grained token_usage row. On conflict the counts are REPLACED
 * (the caller recomputes complete totals per run), mirroring token_rollups.
 */
export async function upsertTokenUsage(row: TokenUsageInput): Promise<void> {
  const d = getDb();
  await d.run(
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
       updated_at = datetime('now')`,
    [
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
    ],
  );
  await upsertMachine(row.account_id, row.machine);
}

export async function getTokenUsage(opts: {
  accountId: number;
  sinceDay?: string;
  profile?: string;
  machine?: string;
}): Promise<TokenUsageRow[]> {
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
  return d.all<TokenUsageRow>(
    `SELECT * FROM token_usage WHERE ${clauses.join(" AND ")}
     ORDER BY day DESC, profile, machine, session_id, model`,
    params,
  );
}

// ── context_sessions ─────────────────────────────────────────────────────────

export async function upsertContextSession(row: ContextSessionInput): Promise<void> {
  const d = getDb();
  await d.run(
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
       last_active_at = excluded.last_active_at`,
    [
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
    ],
  );
  await upsertMachine(row.account_id, row.machine);
}

/** Live (non-stale) context sessions for an account, newest-active first. */
export async function getActiveContextSessions(accountId: number): Promise<ContextSessionRow[]> {
  const d = getDb();
  return d.all<ContextSessionRow>(
    `SELECT * FROM context_sessions
     WHERE account_id = ?
       AND last_active_at >= ${nowMinus("days")}
     ORDER BY profile, machine, last_active_at DESC`,
    [accountId, CONTEXT_STALE_DAYS],
  );
}

/** Delete context sessions whose last_active_at is older than the stale window. */
export async function sweepStaleContextSessions(): Promise<number> {
  const d = getDb();
  const result = await d.run(
    `DELETE FROM context_sessions
     WHERE last_active_at < ${nowMinus("days")}`,
    [CONTEXT_STALE_DAYS],
  );
  return result.changes;
}

// ── Per-account abuse / storage caps (count + existence helpers) ─────────────

/** Total token_usage rows owned by an account (cheap COUNT on the account_id index). */
export async function countTokenUsageRows(accountId: number): Promise<number> {
  const d = getDb();
  const row = await d.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM token_usage WHERE account_id = ?",
    [accountId],
  );
  return Number(row?.n ?? 0);
}

/**
 * Whether a token_usage row already exists for this exact unique key. Used by
 * the per-account row cap to distinguish an UPDATE (always allowed) from an
 * INSERT of a brand-new key (blocked when the account is at its cap).
 */
export async function tokenUsageRowExists(row: {
  account_id: number;
  profile: string;
  machine: string;
  session_id: string;
  model: string;
  settings_hash: string;
  day: string;
}): Promise<boolean> {
  const d = getDb();
  const hit = await d.get(
    `SELECT 1 FROM token_usage
     WHERE account_id = ? AND profile = ? AND machine = ? AND session_id = ?
       AND model = ? AND settings_hash = ? AND day = ? LIMIT 1`,
    [
      row.account_id,
      row.profile,
      row.machine,
      row.session_id,
      row.model,
      row.settings_hash,
      row.day,
    ],
  );
  return hit !== undefined;
}

/** Total context_sessions rows owned by an account. */
export async function countContextSessions(accountId: number): Promise<number> {
  const d = getDb();
  const row = await d.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM context_sessions WHERE account_id = ?",
    [accountId],
  );
  return Number(row?.n ?? 0);
}

/** Whether a context_sessions row already exists for this unique key (UPDATE vs INSERT). */
export async function contextSessionExists(row: {
  account_id: number;
  profile: string;
  machine: string;
  session_id: string;
}): Promise<boolean> {
  const d = getDb();
  const hit = await d.get(
    `SELECT 1 FROM context_sessions
     WHERE account_id = ? AND profile = ? AND machine = ? AND session_id = ? LIMIT 1`,
    [row.account_id, row.profile, row.machine, row.session_id],
  );
  return hit !== undefined;
}

/** Count of an account's non-revoked ingest tokens (the per-account machine/token cap). */
export async function countActiveIngestTokens(accountId: number): Promise<number> {
  const d = getDb();
  const row = await d.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM ingest_tokens WHERE account_id = ? AND revoked_at IS NULL",
    [accountId],
  );
  return Number(row?.n ?? 0);
}

// ── Pricing ──────────────────────────────────────────────────────────────────

export async function getPricingDefaults(): Promise<PricingRow[]> {
  const d = getDb();
  return d.all<PricingRow>(
    "SELECT model, settings_match_json, input, output, cache_write_5m, cache_write_1h, cache_read, source_url, as_of FROM pricing_defaults",
  );
}

export async function getPricingOverrides(accountId: number): Promise<PricingOverrideRow[]> {
  const d = getDb();
  return d.all<PricingOverrideRow>(
    "SELECT model, settings_match_json, input, output, cache_write_5m, cache_write_1h, cache_read FROM pricing_overrides WHERE account_id = ?",
    [accountId],
  );
}

export async function upsertPricingOverride(accountId: number, row: PricingOverrideRow): Promise<void> {
  const d = getDb();
  await d.run(
    `INSERT INTO pricing_overrides
       (account_id, model, settings_match_json, input, output, cache_write_5m, cache_write_1h, cache_read, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(account_id, model, settings_match_json) DO UPDATE SET
       input = excluded.input,
       output = excluded.output,
       cache_write_5m = excluded.cache_write_5m,
       cache_write_1h = excluded.cache_write_1h,
       cache_read = excluded.cache_read,
       updated_at = datetime('now')`,
    [
      accountId,
      row.model,
      row.settings_match_json,
      row.input,
      row.output,
      row.cache_write_5m,
      row.cache_write_1h,
      row.cache_read,
    ],
  );
}

/** Delete all overrides for a model (reset to default). Returns rows removed. */
export async function deletePricingOverride(accountId: number, model: string): Promise<number> {
  const d = getDb();
  const result = await d.run(
    "DELETE FROM pricing_overrides WHERE account_id = ? AND model = ?",
    [accountId, model],
  );
  return result.changes;
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
export async function getFineTokenReport(opts: {
  accountId: number;
  identity: string;
  granularity?: "daily" | "weekly";
  days?: number;
  drill?: ReportDrill;
  profile?: string;
  machine?: string;
}): Promise<FineTokenReport> {
  const granularity = opts.granularity ?? "daily";
  const days = opts.days ?? 30;
  const drill = opts.drill ?? "profile";
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);

  const rows = await getTokenUsage({
    accountId: opts.accountId,
    sinceDay,
    profile: opts.profile,
    machine: opts.machine,
  });

  const defaults = await getPricingDefaults();
  const overrides = await getPricingOverrides(opts.accountId);

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

export async function closeDb(): Promise<void> {
  if (backend) {
    await backend.close();
    backend = undefined;
  }
}

/**
 * Test/migration helper: the active Backend (or undefined). Lets the migration
 * tool and parity tests reach the low-level adapter without re-deriving it.
 */
export function getBackend(): Backend | undefined {
  return backend;
}
