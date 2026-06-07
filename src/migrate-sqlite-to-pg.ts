/**
 * One-time data migration: copy every table from a local SQLite usage.db into a
 * Postgres database.
 *
 * USAGE (never runs automatically — only via these explicit entrypoints):
 *   npm run migrate:pg
 *   node dist/index.js --migrate-sqlite-to-pg
 *
 * SOURCE  (SQLite, opened READ-ONLY):
 *   CLAUDE_PULSE_SQLITE_PATH   (default ~/.claude-pulse/usage.db)
 * TARGET  (Postgres):
 *   CLAUDE_PULSE_PG_URL  (postgres://user:pass@host:5432/db)
 *   — or the discrete CLAUDE_PULSE_PG_HOST/PORT/DATABASE/USER/PASSWORD vars.
 *
 * Behaviour:
 *   - Ensures the PG schema exists (runs the same initDb DDL).
 *   - Copies EVERY table preserving primary keys and foreign-key order.
 *   - IDEMPOTENT via TRUNCATE-then-load: every target table is truncated
 *     (CASCADE) before loading, so re-running yields the same final state.
 *   - For identity-PK tables, ids are inserted explicitly with
 *     `OVERRIDING SYSTEM VALUE` and the identity sequence is re-synced afterward.
 *   - Prints per-table row counts.
 *
 * It does NOT mutate the SQLite source (read-only handle).
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import {
  createSqliteBackend,
  createPgBackend,
  pgConfigFromEnv,
  type Backend,
} from "./db.js";
import { initDb, closeDb, getBackend } from "./store.js";

function log(msg: string): void {
  process.stderr.write(`[claude-pulse migrate] ${msg}\n`);
}

/** Tables in foreign-key-safe load order (parents before children). */
interface TableSpec {
  name: string;
  /** Column list (explicit, so SQLite and PG agree on order). */
  columns: string[];
  /** True when the table has an identity `id` PK that must be inserted explicitly. */
  hasIdentityId: boolean;
}

const TABLES: TableSpec[] = [
  {
    name: "accounts",
    columns: ["id", "identity", "display_name", "created_at"],
    hasIdentityId: true,
  },
  {
    name: "profiles",
    columns: [
      "name",
      "config_dir",
      "poll_interval_minutes",
      "vendor",
      "monthly_budget_usd",
      "api_key",
      "account_id",
      "created_at",
      "updated_at",
    ],
    hasIdentityId: false,
  },
  {
    name: "usage_snapshots",
    columns: [
      "id",
      "profile",
      "five_hour_pct",
      "five_hour_resets_at",
      "seven_day_pct",
      "seven_day_resets_at",
      "raw_response",
      "polled_at",
      "context_tokens",
      "context_pct",
      "context_session_id",
      "context_model",
      "context_effective_limit",
      "context_last_reset_at",
      "account_id",
    ],
    hasIdentityId: true,
  },
  {
    name: "gemini_quota",
    columns: ["id", "timestamp", "model_id", "remaining_fraction", "remaining_amount", "reset_time"],
    hasIdentityId: true,
  },
  {
    name: "alert_subscriptions",
    columns: [
      "id",
      "account_id",
      "profile",
      "alert_type",
      "threshold",
      "channel",
      "cooldown_minutes",
      "enabled",
      "created_at",
    ],
    hasIdentityId: true,
  },
  {
    name: "alert_events",
    columns: [
      "id",
      "account_id",
      "subscription_id",
      "profile",
      "alert_type",
      "message",
      "current_value",
      "threshold",
      "acknowledged",
      "triggered_at",
    ],
    hasIdentityId: true,
  },
  {
    name: "ingest_tokens",
    columns: ["id", "account_id", "machine", "token_hash", "created_at", "last_used_at", "revoked_at"],
    hasIdentityId: true,
  },
  {
    name: "machines",
    columns: ["account_id", "name", "first_seen", "last_seen"],
    hasIdentityId: false,
  },
  {
    name: "token_usage",
    columns: [
      "id",
      "account_id",
      "profile",
      "machine",
      "session_id",
      "model",
      "settings_hash",
      "settings_json",
      "day",
      "tokens_in",
      "tokens_out",
      "cache_write_5m",
      "cache_write_1h",
      "cache_read",
      "source",
      "updated_at",
    ],
    hasIdentityId: true,
  },
  {
    name: "context_sessions",
    columns: [
      "account_id",
      "profile",
      "machine",
      "session_id",
      "model",
      "settings_json",
      "context_tokens",
      "context_pct",
      "effective_limit",
      "updated_at",
      "last_active_at",
    ],
    hasIdentityId: false,
  },
  {
    name: "token_rollups",
    columns: [
      "id",
      "profile",
      "host",
      "day",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_creation_tokens",
      "cache_read_tokens",
      "cost_usd",
      "source",
      "updated_at",
    ],
    hasIdentityId: true,
  },
  {
    name: "pricing_defaults",
    columns: [
      "model",
      "settings_match_json",
      "input",
      "output",
      "cache_write_5m",
      "cache_write_1h",
      "cache_read",
      "source_url",
      "as_of",
    ],
    hasIdentityId: false,
  },
  {
    name: "pricing_overrides",
    columns: [
      "account_id",
      "model",
      "settings_match_json",
      "input",
      "output",
      "cache_write_5m",
      "cache_write_1h",
      "cache_read",
      "updated_at",
    ],
    hasIdentityId: false,
  },
];

function sqlitePath(): string {
  return (
    process.env.CLAUDE_PULSE_SQLITE_PATH ||
    path.join(os.homedir(), ".claude-pulse", "usage.db")
  );
}

/** Build a parameterised multi-row INSERT for one chunk of rows. */
function buildInsert(
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  overridingIdentity: boolean,
): { sql: string; params: unknown[] } {
  const colList = columns.join(", ");
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const row of rows) {
    const placeholders: string[] = [];
    for (const c of columns) {
      placeholders.push(`$${p++}`);
      params.push(row[c] ?? null);
    }
    tuples.push(`(${placeholders.join(", ")})`);
  }
  const overriding = overridingIdentity ? " OVERRIDING SYSTEM VALUE" : "";
  const sql = `INSERT INTO ${table} (${colList})${overriding} VALUES ${tuples.join(", ")}`;
  return { sql, params };
}

const INSERT_CHUNK = 500;

async function copyTable(
  spec: TableSpec,
  sqlite: Backend,
  pgRaw: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
): Promise<number> {
  const rows = await sqlite.all<Record<string, unknown>>(
    `SELECT ${spec.columns.join(", ")} FROM ${spec.name}`,
  );

  // Truncate (idempotent load). CASCADE handles FK children that get reloaded
  // immediately after in their own pass.
  await pgRaw.query(`TRUNCATE TABLE ${spec.name} RESTART IDENTITY CASCADE`);

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    if (chunk.length === 0) continue;
    const { sql, params } = buildInsert(spec.name, spec.columns, chunk, spec.hasIdentityId);
    await pgRaw.query(sql, params);
  }

  // Re-sync the identity sequence so future inserts don't collide with copied ids.
  if (spec.hasIdentityId && rows.length > 0) {
    await pgRaw.query(
      `SELECT setval(
         pg_get_serial_sequence('${spec.name}', 'id'),
         (SELECT COALESCE(MAX(id), 1) FROM ${spec.name}),
         true
       )`,
    );
  }

  return rows.length;
}

/**
 * Run the SQLite → Postgres migration. Resolves with per-table counts.
 */
export async function migrateSqliteToPg(): Promise<Record<string, number>> {
  if (!pgConfigFromEnv()) {
    throw new Error(
      "CLAUDE_PULSE_PG_URL (or CLAUDE_PULSE_PG_* vars) must be set to the target Postgres.",
    );
  }

  const srcPath = sqlitePath();
  log(`Source SQLite (read-only): ${srcPath}`);
  log(`Target Postgres: configured via CLAUDE_PULSE_PG_*`);

  // Open SQLite read-only so we never mutate the source.
  const sqliteDb = new DatabaseSync(srcPath, { readOnly: true });
  const sqlite = createSqliteBackend(sqliteDb);

  // Ensure the PG schema exists by running the normal initDb against PG.
  // (pgConfigFromEnv() being set routes initDb to the Postgres backend.)
  await initDb();
  const pg = getBackend();
  if (!pg || pg.dialect !== "postgres") {
    throw new Error("initDb did not select the Postgres backend — check env vars.");
  }

  // Reach the raw pg query surface via a tiny throwaway PgPoolBackend exec path.
  // We use the public Backend methods for everything except TRUNCATE/setval,
  // which we issue through exec()/all() (they take no params).
  const pgRaw = {
    query: async (sql: string, params?: unknown[]) => {
      if (params && params.length > 0) {
        // run() returns only {changes}; for parameterised INSERTs we go through
        // the backend's all() which executes + returns rows (empty for INSERT).
        await pg.all(sql, params as never);
        return { rows: [], rowCount: null as number | null };
      }
      const rows = await pg.all(sql);
      return { rows, rowCount: null as number | null };
    },
  };

  const counts: Record<string, number> = {};
  try {
    for (const spec of TABLES) {
      const n = await copyTable(spec, sqlite, pgRaw);
      counts[spec.name] = n;
      log(`  ${spec.name}: ${n} row(s)`);
    }
  } finally {
    sqliteDb.close();
    await closeDb();
  }

  log("Migration complete.");
  log(`Per-table counts: ${JSON.stringify(counts)}`);
  return counts;
}

// Allow running this module directly (npm run migrate:pg → tsx src/migrate-sqlite-to-pg.ts).
const invokedDirectly =
  process.argv[1] && /migrate-sqlite-to-pg(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  migrateSqliteToPg()
    .then((counts) => {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      process.stdout.write(`Migrated ${total} rows across ${Object.keys(counts).length} tables.\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`[claude-pulse migrate] FAILED: ${err?.message || err}\n`);
      process.exit(1);
    });
}
