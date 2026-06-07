import { describe, it, expect } from "vitest";
import { toPg, pgConfigFromEnv, pgSelected } from "../src/db.js";

// Pure unit tests for the SQLite→Postgres dialect helpers. No DB needed — these
// run on every `npm test`.

describe("toPg — placeholder + datetime translation", () => {
  it("rewrites ? placeholders to $1,$2,… in order", () => {
    expect(toPg("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("rewrites datetime('now') to now()", () => {
    expect(toPg("INSERT INTO t (created_at) VALUES (datetime('now'))")).toBe(
      "INSERT INTO t (created_at) VALUES (now())",
    );
  });

  it("handles a realistic upsert with several placeholders + datetime('now')", () => {
    const sqlite =
      "INSERT INTO machines (account_id, name) VALUES (?, ?) " +
      "ON CONFLICT(account_id, name) DO UPDATE SET last_seen = datetime('now')";
    expect(toPg(sqlite)).toBe(
      "INSERT INTO machines (account_id, name) VALUES ($1, $2) " +
        "ON CONFLICT(account_id, name) DO UPDATE SET last_seen = now()",
    );
  });

  it("does NOT rewrite ? inside single-quoted string literals", () => {
    expect(toPg("SELECT * FROM t WHERE note = 'why?' AND id = ?")).toBe(
      "SELECT * FROM t WHERE note = 'why?' AND id = $1",
    );
  });

  it("leaves $n placeholders untouched (migration tool emits them directly)", () => {
    expect(toPg("INSERT INTO t (a, b) VALUES ($1, $2)")).toBe(
      "INSERT INTO t (a, b) VALUES ($1, $2)",
    );
  });
});

describe("pgConfigFromEnv / pgSelected", () => {
  it("returns null when no PG env is set", () => {
    const saved = { ...process.env };
    delete process.env.CLAUDE_PULSE_PG_URL;
    delete process.env.CLAUDE_PULSE_PG_HOST;
    try {
      expect(pgConfigFromEnv()).toBeNull();
      expect(pgSelected()).toBe(false);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("prefers CLAUDE_PULSE_PG_URL as a connection string", () => {
    const saved = { ...process.env };
    process.env.CLAUDE_PULSE_PG_URL = "postgres://u:p@h:5432/db";
    try {
      expect(pgConfigFromEnv()).toEqual({ connectionString: "postgres://u:p@h:5432/db" });
      expect(pgSelected()).toBe(true);
    } finally {
      Object.assign(process.env, saved);
      delete process.env.CLAUDE_PULSE_PG_URL;
    }
  });

  it("falls back to discrete CLAUDE_PULSE_PG_* vars when URL absent", () => {
    const saved = { ...process.env };
    delete process.env.CLAUDE_PULSE_PG_URL;
    process.env.CLAUDE_PULSE_PG_HOST = "dbhost";
    process.env.CLAUDE_PULSE_PG_PORT = "6543";
    process.env.CLAUDE_PULSE_PG_DATABASE = "pulse";
    process.env.CLAUDE_PULSE_PG_USER = "u";
    process.env.CLAUDE_PULSE_PG_PASSWORD = "secret";
    try {
      expect(pgConfigFromEnv()).toEqual({
        host: "dbhost",
        port: 6543,
        database: "pulse",
        user: "u",
        password: "secret",
      });
    } finally {
      Object.assign(process.env, saved);
      for (const k of [
        "CLAUDE_PULSE_PG_HOST",
        "CLAUDE_PULSE_PG_PORT",
        "CLAUDE_PULSE_PG_DATABASE",
        "CLAUDE_PULSE_PG_USER",
        "CLAUDE_PULSE_PG_PASSWORD",
      ]) {
        delete process.env[k];
      }
    }
  });
});
