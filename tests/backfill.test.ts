import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initDb,
  closeDb,
  addProfile,
  removeProfile,
  listProfiles,
  getTokenUsage,
  localAccountId,
} from "../src/store.js";
import { runLocalBackfill } from "../src/backfill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-bf-test-"));
  initDb(path.join(tmpDir, "test.db"));

  const cfgDir = path.join(tmpDir, "cfg");
  const dest = path.join(cfgDir, "projects", "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "claude-usage.jsonl"), dest);

  for (const p of listProfiles()) removeProfile(p.name);
  addProfile("fix", cfgDir, 5, "anthropic-oauth");
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runLocalBackfill", () => {
  it("upserts full-history token_usage including old days", async () => {
    const res = await runLocalBackfill();
    const fix = res.find((r) => r.profile === "fix")!;
    expect(fix.fine_rows).toBeGreaterThan(0);

    const rows = getTokenUsage({ accountId: localAccountId() });
    // The fixture's oldest day (2026-06-01) is well outside any 2-day window,
    // so full-history backfill must include it.
    expect(rows.some((r) => r.day === "2026-06-01")).toBe(true);
    expect(rows.some((r) => r.day === "2026-06-02")).toBe(true);
  });

  it("is idempotent — running twice yields the same row counts", async () => {
    await runLocalBackfill();
    const after1 = getTokenUsage({ accountId: localAccountId() });
    const sig1 = after1
      .map((r) => `${r.day}|${r.session_id}|${r.model}|${r.tokens_in}|${r.tokens_out}|${r.cache_read}`)
      .sort();

    await runLocalBackfill();
    const after2 = getTokenUsage({ accountId: localAccountId() });
    const sig2 = after2
      .map((r) => `${r.day}|${r.session_id}|${r.model}|${r.tokens_in}|${r.tokens_out}|${r.cache_read}`)
      .sort();

    expect(after2.length).toBe(after1.length);
    expect(sig2).toEqual(sig1);
  });
});
