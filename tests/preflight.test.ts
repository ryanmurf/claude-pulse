import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectCredentialState } from "../src/auth.js";
import { runProfilePreflight, configDirFromWrapper } from "../src/preflight.js";
import {
  initDb,
  closeDb,
  addProfile,
  getProfile,
  updatePollInterval,
  applySqlitePragmas,
  SQLITE_BUSY_TIMEOUT_MS,
} from "../src/store.js";

let tmpDir: string;

/** Write a credentials file into `dir`, creating it. */
function writeCreds(
  dir: string,
  opts: { accessToken?: string | null; expiresAt?: number | null; raw?: string } = {},
): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".credentials.json");
  if (opts.raw !== undefined) {
    fs.writeFileSync(file, opts.raw);
    return file;
  }
  const oauth: Record<string, unknown> = {
    refreshToken: "refresh-token",
    scopes: ["user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default",
  };
  if (opts.accessToken !== null) oauth.accessToken = opts.accessToken ?? "access-token";
  if (opts.expiresAt !== null) oauth.expiresAt = opts.expiresAt ?? Date.now() + 3_600_000;
  else oauth.expiresAt = null;
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
  return file;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-preflight-"));
  await initDb(path.join(tmpDir, "test.db"));
  // Preflight resolves candidate dirs relative to the home dir; point it at the
  // sandbox so a developer's real ~/.claude* dirs can never affect the test.
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("inspectCredentialState", () => {
  it("reports missing-dir when the config dir does not exist", async () => {
    const r = await inspectCredentialState(path.join(tmpDir, "nope"));
    expect(r.state).toBe("missing-dir");
    expect(r.usable).toBe(false);
  });

  it("reports missing-file when the dir exists but holds no credentials", async () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    const r = await inspectCredentialState(dir);
    expect(r.state).toBe("missing-file");
    expect(r.usable).toBe(false);
  });

  it("reports unparseable for a torn credentials file", async () => {
    const dir = path.join(tmpDir, "torn");
    writeCreds(dir, { raw: "{not json" });
    const r = await inspectCredentialState(dir);
    expect(r.state).toBe("unparseable");
    expect(r.usable).toBe(false);
  });

  it("reports no-access-token when the token is absent", async () => {
    const dir = path.join(tmpDir, "notoken");
    writeCreds(dir, { accessToken: null });
    const r = await inspectCredentialState(dir);
    expect(r.state).toBe("no-access-token");
    expect(r.usable).toBe(false);
  });

  it("reports no-expiry when expiresAt is null — the shape that killed the gauge", async () => {
    const dir = path.join(tmpDir, "noexp");
    writeCreds(dir, { expiresAt: null });
    const r = await inspectCredentialState(dir);
    expect(r.state).toBe("no-expiry");
    expect(r.usable).toBe(false);
  });

  it("reports expired (still usable — refreshable) for a past expiry", async () => {
    const dir = path.join(tmpDir, "old");
    writeCreds(dir, { expiresAt: Date.now() - 60_000 });
    const r = await inspectCredentialState(dir);
    expect(r.state).toBe("expired");
    expect(r.usable).toBe(true);
  });

  it("reports ok for a live token", async () => {
    const dir = path.join(tmpDir, "good");
    writeCreds(dir);
    const r = await inspectCredentialState(dir);
    expect(r.state).toBe("ok");
    expect(r.usable).toBe(true);
  });

  it("never leaks token material into the reported detail", async () => {
    const dir = path.join(tmpDir, "secret");
    writeCreds(dir, { accessToken: "sk-ant-oat01-SUPER-SECRET" });
    const r = await inspectCredentialState(dir);
    expect(JSON.stringify(r)).not.toContain("SUPER-SECRET");
  });
});

describe("configDirFromWrapper", () => {
  it("extracts CLAUDE_CONFIG_DIR from a launcher wrapper, expanding $HOME", async () => {
    const bin = path.join(tmpDir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "claude-max"),
      '#!/usr/bin/env bash\nexport CLAUDE_CONFIG_DIR="$HOME/.claude-max"\nexec claude "$@"\n',
    );
    expect(await configDirFromWrapper("claude-max", [bin])).toBe(path.join(tmpDir, ".claude-max"));
  });

  it("returns null when no wrapper exists", async () => {
    expect(await configDirFromWrapper("claude-nope", [path.join(tmpDir, "bin")])).toBeNull();
  });
});

describe("runProfilePreflight", () => {
  it("heals a profile whose config_dir has drifted to a credential-less dir", async () => {
    // Exactly the live failure: the row says ~/.claude (no usable token) while
    // the claude-max wrapper exports ~/.claude-max (valid credentials).
    writeCreds(path.join(tmpDir, ".claude"), { accessToken: null });
    writeCreds(path.join(tmpDir, ".claude-max"));
    const bin = path.join(tmpDir, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "claude-max"),
      'export CLAUDE_CONFIG_DIR="$HOME/.claude-max"\n',
    );

    await addProfile("claude-max", path.join(tmpDir, ".claude"), 30);
    const results = await runProfilePreflight();

    const entry = results.find((r) => r.profile === "claude-max");
    expect(entry?.healed_from).toBe(path.join(tmpDir, ".claude"));
    expect(entry?.config_dir).toBe(path.join(tmpDir, ".claude-max"));
    expect(entry?.healthy).toBe(true);
    expect((await getProfile("claude-max"))?.config_dir).toBe(path.join(tmpDir, ".claude-max"));
  });

  it("falls back to the ~/.<name> convention when there is no wrapper", async () => {
    writeCreds(path.join(tmpDir, ".claude"), { accessToken: null });
    writeCreds(path.join(tmpDir, ".claude-max"));

    await addProfile("claude-max", path.join(tmpDir, ".claude"), 30);
    await runProfilePreflight();

    expect((await getProfile("claude-max"))?.config_dir).toBe(path.join(tmpDir, ".claude-max"));
  });

  it("preserves an operator-tuned poll interval while healing", async () => {
    writeCreds(path.join(tmpDir, ".claude"), { accessToken: null });
    writeCreds(path.join(tmpDir, ".claude-max"));

    await addProfile("claude-max", path.join(tmpDir, ".claude"), 5);
    await updatePollInterval("claude-max", 30); // deliberate: avoids 429s
    await runProfilePreflight();

    const p = await getProfile("claude-max");
    expect(p?.config_dir).toBe(path.join(tmpDir, ".claude-max"));
    expect(p?.poll_interval_minutes).toBe(30);
  });

  it("never repoints a profile whose current config_dir works", async () => {
    // A deliberate operator choice that authenticates must survive preflight,
    // even when the conventional dir also exists.
    const deliberate = path.join(tmpDir, "deliberate");
    writeCreds(deliberate);
    writeCreds(path.join(tmpDir, ".claude-max"));

    await addProfile("claude-max", deliberate, 30);
    await runProfilePreflight();

    expect((await getProfile("claude-max"))?.config_dir).toBe(deliberate);
  });

  it("never collapses two profiles onto the same config dir", async () => {
    writeCreds(path.join(tmpDir, ".claude-hd"));
    const broken = path.join(tmpDir, "broken");
    writeCreds(broken, { accessToken: null });

    // claude-hd legitimately owns ~/.claude-hd; the drifted profile must not
    // be repointed onto it just because it happens to authenticate.
    await addProfile("claude-hd", path.join(tmpDir, ".claude-hd"), 30);
    await addProfile("claude-hd-max", broken, 30);
    const bin = path.join(tmpDir, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "claude-hd-max"),
      'export CLAUDE_CONFIG_DIR="$HOME/.claude-hd"\n',
    );

    await runProfilePreflight();

    expect((await getProfile("claude-hd-max"))?.config_dir).toBe(broken);
    expect((await getProfile("claude-hd"))?.config_dir).toBe(path.join(tmpDir, ".claude-hd"));
  });

  it("reports drift without correcting it when heal is disabled", async () => {
    writeCreds(path.join(tmpDir, ".claude"), { accessToken: null });
    writeCreds(path.join(tmpDir, ".claude-max"));

    await addProfile("claude-max", path.join(tmpDir, ".claude"), 30);
    const results = await runProfilePreflight({ heal: false });

    expect((await getProfile("claude-max"))?.config_dir).toBe(path.join(tmpDir, ".claude"));
    expect(results.find((r) => r.profile === "claude-max")?.healthy).toBe(false);
  });

  it("flags an unhealable profile instead of silently passing it", async () => {
    writeCreds(path.join(tmpDir, ".claude-max"), { accessToken: null });
    await addProfile("claude-max", path.join(tmpDir, ".claude-max"), 30);

    const entry = (await runProfilePreflight()).find((r) => r.profile === "claude-max");
    expect(entry?.healthy).toBe(false);
    expect(entry?.credentials?.state).toBe("no-access-token");
  });

  it("leaves non-anthropic vendors alone (their config_dir is not a credential store)", async () => {
    await addProfile("codex", path.join(tmpDir, ".codex"), 5, "openai-codex");
    const entry = (await runProfilePreflight()).find((r) => r.profile === "codex");
    expect(entry?.healthy).toBe(true);
    expect(entry?.credentials).toBeNull();
    expect((await getProfile("codex"))?.config_dir).toBe(path.join(tmpDir, ".codex"));
  });
});

describe("sqlite concurrency", () => {
  it("sets a non-zero busy_timeout so concurrent writers queue instead of failing", async () => {
    // The SQLite default (0) turns routine overlap between the agent daemon's
    // poll loops and the every-30-minutes upload cron into hard
    // `database is locked` aborts of the whole run.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(tmpDir, "pragma.db"));
    applySqlitePragmas(db);
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(row.timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
    expect(SQLITE_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
    db.close();
  });
});
