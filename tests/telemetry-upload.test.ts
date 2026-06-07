import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, closeDb, addProfile, removeProfile, listProfiles } from "../src/store.js";
import { computeUpload } from "../src/upload.js";
import { pushToCentral, _resetUploadBackoff, type UploadSnapshot, type UploadGemini } from "../src/upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

const CFG = { baseUrl: "https://central.example", ingestToken: "tok-123" };

describe("pushToCentral — extended payload (snapshots + gemini)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetUploadBackoff();
  });

  it("sends snapshots + gemini on the FIRST chunk exactly once, even with multiple rollup chunks", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Force multiple chunks via byte padding on rollups.
    const rollups = Array.from({ length: 200 }, (_, i) => ({
      profile: "claude-max",
      session_id: `s-${i}`,
      day: "2026-06-01",
      model: "claude-opus-4-8",
      settings: { pad: "x".repeat(10 * 1024) },
      tokens_in: 1,
      tokens_out: 1,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_read: 0,
    }));
    const snapshots: UploadSnapshot[] = [
      { profile: "claude-max", five_hour_pct: 5, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null },
    ];
    const gemini: UploadGemini[] = [
      { model_id: "gemini-2.5-pro", remaining_fraction: 0.5, remaining_amount: null, reset_time: null },
    ];

    const res = await pushToCentral(rollups, [], CFG, { snapshots, gemini });
    expect(res.chunks).toBeGreaterThan(1);
    expect(res.failed).toBe(0);

    let snapSeen = 0;
    let gemSeen = 0;
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      if (Array.isArray(body.snapshots)) snapSeen += body.snapshots.length;
      if (Array.isArray(body.gemini)) gemSeen += body.gemini.length;
    }
    expect(snapSeen).toBe(1);
    expect(gemSeen).toBe(1);
  });

  it("produces a single chunk carrying ONLY snapshots/gemini when there are no rollups/context", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await pushToCentral([], [], CFG, {
      snapshots: [{ profile: "claude-max", five_hour_pct: 1, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null }],
      gemini: [{ model_id: "gemini-2.5-pro", remaining_fraction: 0.5, remaining_amount: null, reset_time: null }],
    });
    expect(res.chunks).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.snapshots.length).toBe(1);
    expect(body.gemini.length).toBe(1);
  });

  it("is a no-op when all sections are empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await pushToCentral([], [], CFG, { snapshots: [], gemini: [] });
    expect(res).toEqual({ chunks: 0, ok: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("computeUpload — include snapshots", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-cu-test-"));
    await initDb(path.join(tmpDir, "test.db"));
    const cfgDir = path.join(tmpDir, "cfg");
    const dest = path.join(cfgDir, "projects", "proj", "session.jsonl");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, "claude-usage.jsonl"), dest);
    for (const p of await listProfiles()) await removeProfile(p.name);
    await addProfile("fix", cfgDir, 5, "anthropic-oauth");
  });
  afterEach(async () => {
    await closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is fail-soft per signal: a profile whose usage read fails still returns rollups + an array of snapshots", async () => {
    // The fixture cfg dir has transcripts (→ rollups) but no OAuth creds, so the
    // 5h/7d usage read fails. computeUpload must NOT throw — snapshots just comes
    // back empty for that profile while rollups still flow.
    const { rollups, snapshots, gemini } = await computeUpload(
      undefined,
      { sinceDays: null },
      undefined,
      { snapshots: true },
    );
    expect(rollups.length).toBeGreaterThan(0);
    expect(Array.isArray(snapshots)).toBe(true);
    expect(gemini).toEqual([]);
  });

  it("returns snapshots when usage is readable (fakeable via a balance profile budget read)", async () => {
    // Add a deepseek-balance profile and stub fetch so fetchUsage succeeds → a
    // real snapshot row is produced.
    await addProfile("ds", path.join(tmpDir, "dscfg"), 5, "deepseek-balance", 100, "sk-test");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: "60.00" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { snapshots } = await computeUpload(undefined, { sinceDays: null }, undefined, { snapshots: true });
    vi.unstubAllGlobals();
    expect(snapshots.some((s) => s.profile === "ds")).toBe(true);
  });

  it("omits snapshots when include is not set", async () => {
    const { snapshots } = await computeUpload(undefined, { sinceDays: null });
    expect(snapshots).toEqual([]);
  });
});
