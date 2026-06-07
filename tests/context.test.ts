import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_CONTEXT_LIMIT,
  effectiveContextForModel,
  findCurrentSessionJsonl,
  readJsonlContext,
  getContextForProfile,
} from "../src/context.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pulse-ctx-test-"));
});

afterEach(async () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function writeJsonl(file: string, lines: any[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("effectiveContextForModel", () => {
  it("returns 1M for opus-4-7", async () => {
    expect(effectiveContextForModel("claude-opus-4-7")).toBe(1_000_000);
    expect(effectiveContextForModel("claude-opus-4-7[1m]")).toBe(1_000_000);
  });
  it("returns 200K for sonnet", async () => {
    expect(effectiveContextForModel("claude-sonnet-4-6")).toBe(200_000);
  });
  it("returns 200K for haiku", async () => {
    expect(effectiveContextForModel("claude-haiku-4-5")).toBe(200_000);
  });
  it("returns default for unknown model", async () => {
    expect(effectiveContextForModel("some-unknown-model-2030")).toBe(DEFAULT_CONTEXT_LIMIT);
  });
  it("handles null/undefined", async () => {
    expect(effectiveContextForModel(null)).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(effectiveContextForModel(undefined)).toBe(DEFAULT_CONTEXT_LIMIT);
  });
  it("matches by prefix for date-suffixed model ids", async () => {
    expect(effectiveContextForModel("claude-haiku-4-5-20251001")).toBe(200_000);
  });
});

describe("findCurrentSessionJsonl", () => {
  it("returns null when no projects dir", async () => {
    expect(findCurrentSessionJsonl(tmpDir)).toBeNull();
  });

  it("picks the most-recently-modified jsonl across projects", async () => {
    const proj1 = path.join(tmpDir, "projects", "proj-a", "old.jsonl");
    const proj2 = path.join(tmpDir, "projects", "proj-b", "new.jsonl");
    writeJsonl(proj1, [{ a: 1 }]);
    writeJsonl(proj2, [{ b: 2 }]);
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(proj1, past, past);
    expect(findCurrentSessionJsonl(tmpDir)).toBe(proj2);
  });

  it("ignores subdirectories (e.g. subagents/)", async () => {
    const subagent = path.join(tmpDir, "projects", "proj-a", "subagents", "sub.jsonl");
    const top = path.join(tmpDir, "projects", "proj-a", "main.jsonl");
    writeJsonl(subagent, [{ s: 1 }]);
    writeJsonl(top, [{ t: 1 }]);
    expect(findCurrentSessionJsonl(tmpDir)).toBe(top);
  });
});

describe("readJsonlContext", () => {
  it("returns null for empty file", async () => {
    const f = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(f, "");
    expect(readJsonlContext(f)).toBeNull();
  });

  it("returns zero context when only header entries (no assistant turns)", async () => {
    const f = path.join(tmpDir, "header.jsonl");
    writeJsonl(f, [
      { type: "last-prompt", sessionId: "abc" },
      { type: "permission-mode", sessionId: "abc" },
    ]);
    const r = readJsonlContext(f);
    expect(r).not.toBeNull();
    expect(r!.context_tokens).toBe(0);
    expect(r!.context_pct).toBe(0);
    expect(r!.session_id).toBe("abc");
  });

  it("sums input + cache_creation + cache_read on latest assistant turn", async () => {
    const f = path.join(tmpDir, "session.jsonl");
    writeJsonl(f, [
      { type: "permission-mode", sessionId: "sess1" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 50000, output_tokens: 500 },
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 700 },
        },
      },
    ]);
    const r = readJsonlContext(f);
    expect(r).not.toBeNull();
    expect(r!.context_tokens).toBe(10 + 1000 + 150000);
    expect(r!.effective_context).toBe(200_000);
    expect(r!.context_pct).toBeCloseTo((151010 / 200_000) * 100, 1);
    expect(r!.model).toBe("claude-sonnet-4-6");
  });

  it("captures latest compact_boundary timestamp", async () => {
    const f = path.join(tmpDir, "compact.jsonl");
    writeJsonl(f, [
      {
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-05-01T00:00:00Z",
        compactMetadata: { trigger: "manual", preTokens: 100000 },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-05-15T12:00:00Z",
        compactMetadata: { trigger: "auto", preTokens: 800000 },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 },
        },
      },
    ]);
    const r = readJsonlContext(f);
    expect(r!.last_reset_at).toBe("2026-05-15T12:00:00Z");
  });

  it("skips corrupted lines without crashing", async () => {
    const f = path.join(tmpDir, "corrupt.jsonl");
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: "permission-mode", sessionId: "x" }),
        "this is not json",
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
          },
        }),
        "{partial-json",
      ].join("\n") + "\n",
    );
    const r = readJsonlContext(f);
    expect(r).not.toBeNull();
    expect(r!.context_tokens).toBe(6);
  });

  it("handles tail-only reads on large files", async () => {
    const f = path.join(tmpDir, "big.jsonl");
    // Write 500KB of filler then a valid last assistant turn
    const filler = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(2000) } });
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(filler);
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: { input_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13 },
        },
      }),
    );
    fs.writeFileSync(f, lines.join("\n") + "\n");
    expect(fs.statSync(f).size).toBeGreaterThan(300_000);
    const r = readJsonlContext(f);
    expect(r).not.toBeNull();
    expect(r!.context_tokens).toBe(31);
  });

  it("user-role messages with usage do not override assistant usage", async () => {
    const f = path.join(tmpDir, "userusage.jsonl");
    writeJsonl(f, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
        },
      },
      {
        // some synthetic compactSummary user message with usage-shaped data shouldn't blow us up
        type: "user",
        message: { role: "user", content: "summary", usage: { input_tokens: 99999 } },
      },
    ]);
    const r = readJsonlContext(f);
    expect(r!.context_tokens).toBe(15);
  });
});

describe("getContextForProfile", () => {
  it("returns null when config dir has no sessions", async () => {
    expect(getContextForProfile(tmpDir)).toBeNull();
  });

  it("expands ~/ prefix", async () => {
    // Just smoke-test path expansion doesn't crash; if the user's home has no
    // ~/.no-such-claude-pulse-dir/, returns null.
    expect(getContextForProfile("~/.no-such-claude-pulse-dir-test")).toBeNull();
  });
});
