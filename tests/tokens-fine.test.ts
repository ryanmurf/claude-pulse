import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { tallyProfileFineGrained, splitCacheCreation } from "../src/tokens.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-fine-test-"));
});
afterEach(async () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
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

describe("splitCacheCreation", () => {
  it("reads ephemeral 5m/1h sub-fields when present", async () => {
    const { c5m, c1h } = splitCacheCreation({
      cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
      cache_creation_input_tokens: 2000,
    });
    expect(c5m).toBe(1500);
    expect(c1h).toBe(500);
  });

  it("falls back to lumping the flat total into 5m when sub-fields absent", async () => {
    const { c5m, c1h } = splitCacheCreation({ cache_creation_input_tokens: 700 });
    expect(c5m).toBe(700);
    expect(c1h).toBe(0);
  });
});

describe("tallyProfileFineGrained — Claude", () => {
  it("emits per-(session,model,settings) rows with cache split and dedupe", async () => {
    copyFixtureToProjects("claude-fine.jsonl");
    const rows = await tallyProfileFineGrained({
      name: "test",
      config_dir: tmpDir,
      vendor: "anthropic-oauth",
    });

    const opus = rows.find((r) => r.session_id === "sess-1" && r.model === "claude-opus-4-8")!;
    expect(opus).toBeDefined();
    // Two identical msg_A lines must collapse (dedupe by id+requestId).
    expect(opus.tokens_in).toBe(1000);
    expect(opus.tokens_out).toBe(500);
    expect(opus.cache_write_5m).toBe(1500);
    expect(opus.cache_write_1h).toBe(500);
    expect(opus.cache_read).toBe(8000);
    expect(opus.settings_json).toBe('{"service_tier":"standard"}');

    // sonnet row in a different session, no ephemeral split → lumped 5m.
    const sonnet = rows.find((r) => r.session_id === "sess-2" && r.model === "claude-sonnet-4-6")!;
    expect(sonnet.cache_write_5m).toBe(400);
    expect(sonnet.cache_write_1h).toBe(0);
    expect(sonnet.settings_json).toBe("{}");

    // user-role usage line must not appear
    expect(rows.every((r) => r.tokens_in !== 99999)).toBe(true);
  });
});

describe("tallyProfileFineGrained — codex", () => {
  it("tags effort settings + per-session, splits cached out of input", async () => {
    copyFixtureToSessions("codex-rollout.jsonl");
    const rows = await tallyProfileFineGrained({
      name: "codex",
      config_dir: tmpDir,
      vendor: "openai-codex",
    });
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.model).toBe("gpt-5.5");
    expect(r.tokens_in).toBe(300);
    expect(r.cache_read).toBe(1200);
    expect(r.tokens_out).toBe(360);
    expect(r.cache_write_5m).toBe(0);
    // session_id falls back to the rollout filename (no per-line sessionId in codex).
    expect(r.session_id).toBe("rollout-x");
  });
});
