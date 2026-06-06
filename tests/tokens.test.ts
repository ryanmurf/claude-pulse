import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  rateForModel,
  costForTokens,
  tallyProfileTokens,
  MODEL_PRICING,
  DEFAULT_RATE,
} from "../src/tokens.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-tok-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function copyFixtureToProjects(fixture: string): void {
  const dest = path.join(tmpDir, "projects", "some-project", "session.jsonl");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), dest);
}

function copyFixtureToSessions(fixture: string): void {
  const dest = path.join(tmpDir, "sessions", "2026", "06", "01", "rollout-x.jsonl");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), dest);
}

describe("rateForModel", () => {
  it("exact-matches a base key", () => {
    expect(rateForModel("claude-opus-4").known).toBe(true);
  });
  it("prefix-matches a dated model id", () => {
    const r = rateForModel("claude-opus-4-8-20260115");
    expect(r.known).toBe(true);
    expect(r.rate).toEqual(MODEL_PRICING["claude-opus-4"]);
  });
  it("prefers the longest matching prefix", () => {
    expect(rateForModel("gpt-5.5").rate).toEqual(MODEL_PRICING["gpt-5"]);
  });
  it("falls back + marks unknown for unrecognised models", () => {
    const r = rateForModel("some-future-model-2099");
    expect(r.known).toBe(false);
    expect(r.rate).toEqual(DEFAULT_RATE);
  });
  it("handles null", () => {
    expect(rateForModel(null).known).toBe(false);
  });
});

describe("costForTokens", () => {
  it("computes opus cost across all four token classes", () => {
    // opus: input 15, output 75, cacheWrite 18.75, cacheRead 1.5 (per 1M)
    const cost = costForTokens(
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_tokens: 1_000_000, cache_read_tokens: 1_000_000 },
      "claude-opus-4-8",
    );
    expect(cost).toBeCloseTo(15 + 75 + 18.75 + 1.5, 6);
  });
  it("scales linearly with token volume", () => {
    const cost = costForTokens(
      { input_tokens: 100_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
      "claude-sonnet-4-6",
    );
    expect(cost).toBeCloseTo((100_000 / 1_000_000) * 3, 6);
  });
});

describe("tallyProfileTokens — Claude", () => {
  it("sums per (day, model), dedupes by message id + requestId, and skips user usage", async () => {
    copyFixtureToProjects("claude-usage.jsonl");
    const rows = await tallyProfileTokens({
      name: "test",
      config_dir: tmpDir,
      vendor: "anthropic-oauth",
    });

    // Expect: 2026-06-01 opus (deduped to one), 2026-06-01 sonnet, 2026-06-02 opus.
    // The user-role usage line (99999) must NOT appear; the no-usage haiku line ignored.
    const byKey = new Map(rows.map((r) => [`${r.day} ${r.model}`, r]));

    const opusD1 = byKey.get("2026-06-01 claude-opus-4-8")!;
    expect(opusD1).toBeDefined();
    // Two identical msg_A rows must collapse to one (dedupe).
    expect(opusD1.input_tokens).toBe(1000);
    expect(opusD1.output_tokens).toBe(500);
    expect(opusD1.cache_creation_tokens).toBe(2000);
    expect(opusD1.cache_read_tokens).toBe(8000);
    // opus cost = (1000*15 + 500*75 + 2000*18.75 + 8000*1.5)/1e6
    expect(opusD1.cost_usd).toBeCloseTo(
      (1000 * 15 + 500 * 75 + 2000 * 18.75 + 8000 * 1.5) / 1_000_000,
      6,
    );

    const sonnetD1 = byKey.get("2026-06-01 claude-sonnet-4-6")!;
    expect(sonnetD1.input_tokens).toBe(300);
    expect(sonnetD1.output_tokens).toBe(1200);
    expect(sonnetD1.cache_read_tokens).toBe(4000);

    const opusD2 = byKey.get("2026-06-02 claude-opus-4-8")!;
    expect(opusD2.input_tokens).toBe(50);

    // No row should carry the user-message 99999 figure.
    expect(rows.every((r) => r.input_tokens !== 99999)).toBe(true);
  });

  it("filters out days before sinceDay", async () => {
    copyFixtureToProjects("claude-usage.jsonl");
    const rows = await tallyProfileTokens(
      { name: "test", config_dir: tmpDir, vendor: "anthropic-oauth" },
      "2026-06-02",
    );
    expect(rows.every((r) => r.day >= "2026-06-02")).toBe(true);
    expect(rows.some((r) => r.day === "2026-06-01")).toBe(false);
  });

  it("returns empty for a config dir with no transcripts", async () => {
    const rows = await tallyProfileTokens({
      name: "empty",
      config_dir: tmpDir,
      vendor: "anthropic-oauth",
    });
    expect(rows).toEqual([]);
  });
});

describe("tallyProfileTokens — codex", () => {
  it("sums last_token_usage deltas, splits cached out of input, attributes to turn_context model", async () => {
    copyFixtureToSessions("codex-rollout.jsonl");
    const rows = await tallyProfileTokens({
      name: "codex",
      config_dir: tmpDir,
      vendor: "openai-codex",
    });
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.day).toBe("2026-06-01");
    expect(r.model).toBe("gpt-5.5");
    // input = (1000-800) + (500-400) = 300 uncached
    expect(r.input_tokens).toBe(300);
    // cache_read = 800 + 400 = 1200
    expect(r.cache_read_tokens).toBe(1200);
    // output = (200+100) + (50+10) = 360
    expect(r.output_tokens).toBe(360);
    expect(r.cache_creation_tokens).toBe(0);
  });

  it("returns empty (no crash) for a codex dir with no token events", async () => {
    const dest = path.join(tmpDir, "sessions", "rollout-empty.jsonl");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }) + "\n");
    const rows = await tallyProfileTokens({
      name: "codex",
      config_dir: tmpDir,
      vendor: "openai-codex",
    });
    expect(rows).toEqual([]);
  });
});
