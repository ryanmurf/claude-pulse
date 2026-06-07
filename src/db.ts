/**
 * Dual-backend async data layer for claude-pulse.
 *
 * The store (src/store.ts) is written ONCE against the small async `Backend`
 * adapter defined here. Two implementations are provided:
 *
 *   - SQLite (default) — wraps the synchronous node:sqlite `DatabaseSync`. The
 *     methods are async but resolve synchronously-computed results, so remote
 *     uploaders (clu/midnight) keep working with zero config.
 *   - Postgres — used when `CLAUDE_PULSE_PG_URL` (a `postgres://…` connection
 *     string) is set. Backed by a `pg` `Pool`.
 *
 * Dialect handling: store functions write SQLite-flavoured SQL (`?` placeholders,
 * `datetime('now')`). The Postgres backend rewrites `?` → `$1,$2,…` and
 * `datetime('now')` → `now()` at execution time. Where the dialects diverge too
 * much to paper over (identity columns, `RETURNING id`, expression indexes,
 * upsert conflict targets) the schema/DDL is written per-backend in store.ts via
 * the `dialect` flag, and inserts that need the new row id go through
 * `insertReturningId`.
 */

import { DatabaseSync } from "node:sqlite";

export type Dialect = "sqlite" | "postgres";

/** A row is a plain object keyed by column name. */
export type Row = Record<string, unknown>;

/** Parameter values we bind into statements. */
export type Param = string | number | bigint | boolean | null | undefined;

export interface RunResult {
  /** Rows affected (INSERT/UPDATE/DELETE). */
  changes: number;
}

/**
 * The minimal async query surface every store function is written against.
 * Implemented twice (SQLite + Postgres).
 */
export interface Backend {
  readonly dialect: Dialect;

  /** Run a query returning all rows. */
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;

  /** Run a query returning the first row (or undefined). */
  get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined>;

  /** Run a write statement; returns the number of rows changed. */
  run(sql: string, params?: Param[]): Promise<RunResult>;

  /**
   * Run an INSERT and return the generated integer primary key. The caller's
   * `sql` is a plain `INSERT … VALUES …` (no RETURNING). SQLite uses
   * lastInsertRowid; Postgres appends `RETURNING id`.
   */
  insertReturningId(sql: string, params?: Param[]): Promise<number>;

  /** Execute one or more statements with no parameters (DDL, PRAGMA). */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a transaction. Commits on resolve, rolls back on throw.
   * The same Backend instance is passed through (SQLite is single-connection;
   * the Postgres impl pins one pooled client for the duration).
   */
  transaction<T>(fn: (tx: Backend) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

// ── SQLite backend ───────────────────────────────────────────────────────────

class SqliteBackend implements Backend {
  readonly dialect: Dialect = "sqlite";
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private bind(params?: Param[]): Param[] {
    // node:sqlite rejects `undefined`; normalise to null.
    return (params ?? []).map((p) => (p === undefined ? null : p));
  }

  async all<T = Row>(sql: string, params?: Param[]): Promise<T[]> {
    return this.db.prepare(sql).all(...(this.bind(params) as never[])) as unknown as T[];
  }

  async get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined> {
    const row = this.db.prepare(sql).get(...(this.bind(params) as never[]));
    return row as unknown as T | undefined;
  }

  async run(sql: string, params?: Param[]): Promise<RunResult> {
    const r = this.db.prepare(sql).run(...(this.bind(params) as never[]));
    return { changes: Number(r.changes) };
  }

  async insertReturningId(sql: string, params?: Param[]): Promise<number> {
    const r = this.db.prepare(sql).run(...(this.bind(params) as never[]));
    return Number(r.lastInsertRowid);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Backend) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* noop */
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** Direct handle (for the rare in-store rebuild that needs raw exec). */
  raw(): DatabaseSync {
    return this.db;
  }
}

export function createSqliteBackend(db: DatabaseSync): Backend {
  return new SqliteBackend(db);
}

// ── Postgres backend ─────────────────────────────────────────────────────────
//
// `pg` is imported lazily so the SQLite-only path (uploaders) never needs the
// dependency loaded at runtime.

/**
 * Translate SQLite-flavoured SQL to Postgres:
 *   - `?` positional placeholders → `$1, $2, …` (skips `?` inside string
 *     literals; our SQL has none, but be safe).
 *   - `datetime('now')` → `now()` (covers the timestamp-default columns; we keep
 *     timestamp columns as TEXT in PG so the stored value is a string either way).
 *
 * It does NOT touch `ON CONFLICT`, which is compatible between the two dialects
 * for our usage (named conflict targets + `excluded.`).
 */
export function toPg(sql: string): string {
  // datetime('now') → now()  (case/space tolerant)
  let out = sql.replace(/datetime\(\s*'now'\s*\)/gi, "now()");

  // ? → $n, ignoring any inside single-quoted string literals.
  let n = 0;
  let inStr = false;
  let result = "";
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === "'") {
      // Handle escaped '' inside a string literal.
      if (inStr && out[i + 1] === "'") {
        result += "''";
        i++;
        continue;
      }
      inStr = !inStr;
      result += ch;
      continue;
    }
    if (ch === "?" && !inStr) {
      n += 1;
      result += `$${n}`;
      continue;
    }
    result += ch;
  }
  out = result;
  return out;
}

// Minimal structural types for the `pg` module so we don't hard-depend on its
// types at compile time on the SQLite-only path.
interface PgQueryResult {
  rows: Row[];
  rowCount: number | null;
}
interface PgClient {
  query(text: string, values?: Param[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPool {
  query(text: string, values?: Param[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

/** A backend backed by a single pinned pg client (used inside transactions). */
class PgClientBackend implements Backend {
  readonly dialect: Dialect = "postgres";
  constructor(private client: PgClient) {}

  private norm(params?: Param[]): Param[] {
    return (params ?? []).map((p) => (p === undefined ? null : p));
  }

  async all<T = Row>(sql: string, params?: Param[]): Promise<T[]> {
    const r = await this.client.query(toPg(sql), this.norm(params));
    return r.rows as unknown as T[];
  }
  async get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined> {
    const r = await this.client.query(toPg(sql), this.norm(params));
    return r.rows[0] as unknown as T | undefined;
  }
  async run(sql: string, params?: Param[]): Promise<RunResult> {
    const r = await this.client.query(toPg(sql), this.norm(params));
    return { changes: r.rowCount ?? 0 };
  }
  async insertReturningId(sql: string, params?: Param[]): Promise<number> {
    const r = await this.client.query(`${toPg(sql)} RETURNING id`, this.norm(params));
    return Number((r.rows[0] as { id: number }).id);
  }
  async exec(sql: string): Promise<void> {
    await this.client.query(toPg(sql));
  }
  async transaction<T>(fn: (tx: Backend) => Promise<T>): Promise<T> {
    // Nested: reuse this pinned client (Postgres has no nested BEGIN; rely on the
    // outer transaction). We don't issue another BEGIN here.
    return fn(this);
  }
  async close(): Promise<void> {
    /* the pool owns the client lifecycle; release happens in PgPoolBackend */
  }
}

class PgPoolBackend implements Backend {
  readonly dialect: Dialect = "postgres";
  constructor(private pool: PgPool) {}

  private norm(params?: Param[]): Param[] {
    return (params ?? []).map((p) => (p === undefined ? null : p));
  }

  async all<T = Row>(sql: string, params?: Param[]): Promise<T[]> {
    const r = await this.pool.query(toPg(sql), this.norm(params));
    return r.rows as unknown as T[];
  }
  async get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined> {
    const r = await this.pool.query(toPg(sql), this.norm(params));
    return r.rows[0] as unknown as T | undefined;
  }
  async run(sql: string, params?: Param[]): Promise<RunResult> {
    const r = await this.pool.query(toPg(sql), this.norm(params));
    return { changes: r.rowCount ?? 0 };
  }
  async insertReturningId(sql: string, params?: Param[]): Promise<number> {
    const r = await this.pool.query(`${toPg(sql)} RETURNING id`, this.norm(params));
    return Number((r.rows[0] as { id: number }).id);
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(toPg(sql));
  }
  async transaction<T>(fn: (tx: Backend) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new PgClientBackend(client);
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* noop */
      }
      throw e;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Build a Postgres connection config from the env contract. `CLAUDE_PULSE_PG_URL`
 * (a `postgres://…` string) takes precedence; otherwise discrete
 * `CLAUDE_PULSE_PG_HOST/PORT/DATABASE/USER/PASSWORD` are assembled.
 */
export function pgConfigFromEnv():
  | { connectionString: string }
  | { host: string; port: number; database?: string; user?: string; password?: string }
  | null {
  const url = process.env.CLAUDE_PULSE_PG_URL;
  if (url && url.trim()) return { connectionString: url.trim() };

  const host = process.env.CLAUDE_PULSE_PG_HOST;
  if (host && host.trim()) {
    return {
      host: host.trim(),
      port: Number(process.env.CLAUDE_PULSE_PG_PORT || "5432"),
      database: process.env.CLAUDE_PULSE_PG_DATABASE || undefined,
      user: process.env.CLAUDE_PULSE_PG_USER || undefined,
      password: process.env.CLAUDE_PULSE_PG_PASSWORD || undefined,
    };
  }
  return null;
}

/** True when the env selects the Postgres backend. */
export function pgSelected(): boolean {
  return pgConfigFromEnv() !== null;
}

/**
 * Create a Postgres-backed Backend from an explicit config (or the env). `pg` is
 * imported dynamically so the SQLite-only path never loads it.
 */
export async function createPgBackend(
  config?: Record<string, unknown>,
): Promise<Backend> {
  const cfg = config ?? (pgConfigFromEnv() as Record<string, unknown> | null);
  if (!cfg) throw new Error("Postgres not configured (set CLAUDE_PULSE_PG_URL).");
  // Dynamic import keeps pg out of the SQLite-only runtime path.
  const pgModule = (await import("pg")) as unknown as {
    default?: {
      Pool: new (c: Record<string, unknown>) => PgPool;
      types?: { setTypeParser(oid: number, fn: (v: string) => unknown): void };
    };
    Pool?: new (c: Record<string, unknown>) => PgPool;
    types?: { setTypeParser(oid: number, fn: (v: string) => unknown): void };
  };
  const Pool = pgModule.Pool ?? pgModule.default?.Pool;
  if (!Pool) throw new Error("Could not load pg.Pool");

  // By default pg returns BIGINT (int8, oid 20) and NUMERIC (oid 1700) as
  // strings to avoid precision loss. Our id columns are BIGINT GENERATED IDENTITY
  // and stay well within Number's safe range — parse them to numbers so the rest
  // of the code (which treats ids as numbers) works identically to SQLite.
  const types = pgModule.types ?? pgModule.default?.types;
  if (types) {
    types.setTypeParser(20, (v: string) => (v === null ? null : Number(v)));
  }
  const pool = new Pool(cfg);
  return new PgPoolBackend(pool);
}
