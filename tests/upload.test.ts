import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunkUpload,
  pushToCentral,
  reportToCentral,
  uploadConfig,
  _resetUploadBackoff,
  INGEST_SAFE_BYTES,
  MAX_ROWS_PER_CHUNK,
  type UploadRollup,
  type UploadContext,
} from "../src/upload.js";

const CFG = { baseUrl: "https://central.example", ingestToken: "tok-123" };

function makeRollup(i: number, padBytes = 0): UploadRollup {
  return {
    profile: "claude-max",
    session_id: `sess-${i}`,
    day: "2026-06-01",
    model: "claude-opus-4-8",
    settings: padBytes > 0 ? { pad: "x".repeat(padBytes) } : {},
    tokens_in: 100,
    tokens_out: 50,
    cache_write_5m: 10,
    cache_write_1h: 0,
    cache_read: 200,
  };
}

function makeContext(i: number): UploadContext {
  return {
    profile: "claude-max",
    session_id: `ctx-${i}`,
    model: "claude-opus-4-8",
    context_tokens: 1000,
    context_pct: 5,
    effective_limit: 200000,
    last_active_at: "2026-06-01T10:00:00.000Z",
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetUploadBackoff();
  delete process.env.CLAUDE_PULSE_UPLOAD_TO;
  delete process.env.CLAUDE_PULSE_INGEST_TOKEN;
});

describe("uploadConfig", () => {
  it("returns null unless both env vars are set", async () => {
    expect(uploadConfig()).toBeNull();
    process.env.CLAUDE_PULSE_UPLOAD_TO = "https://x";
    expect(uploadConfig()).toBeNull();
    process.env.CLAUDE_PULSE_INGEST_TOKEN = "tok";
    expect(uploadConfig()).toEqual({ baseUrl: "https://x", ingestToken: "tok" });
  });
  it("strips a trailing slash from the base URL", async () => {
    process.env.CLAUDE_PULSE_UPLOAD_TO = "https://x/";
    process.env.CLAUDE_PULSE_INGEST_TOKEN = "tok";
    expect(uploadConfig()!.baseUrl).toBe("https://x");
  });
});

describe("chunkUpload", () => {
  it("packs small rows into a single chunk", async () => {
    const rollups = Array.from({ length: 10 }, (_, i) => makeRollup(i));
    const chunks = chunkUpload(rollups, []);
    expect(chunks.length).toBe(1);
    expect(chunks[0].rollups.length).toBe(10);
  });

  it("splits by row count past MAX_ROWS_PER_CHUNK", async () => {
    const rollups = Array.from({ length: MAX_ROWS_PER_CHUNK + 50 }, (_, i) => makeRollup(i));
    const chunks = chunkUpload(rollups, []);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.rollups.length).toBeLessThanOrEqual(MAX_ROWS_PER_CHUNK);
    const total = chunks.reduce((a, c) => a + c.rollups.length, 0);
    expect(total).toBe(MAX_ROWS_PER_CHUNK + 50);
  });

  it("splits a large batch into multiple chunks each under the byte cap", async () => {
    // ~10KB padding per row × 200 rows ≈ 2MB → must split into several <1MB chunks.
    const rollups = Array.from({ length: 200 }, (_, i) => makeRollup(i, 10 * 1024));
    const chunks = chunkUpload(rollups, []);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const bytes = Buffer.byteLength(JSON.stringify({ rollups: c.rollups, context: c.context }));
      expect(bytes).toBeLessThanOrEqual(INGEST_SAFE_BYTES);
    }
    // No rows dropped.
    const total = chunks.reduce((a, c) => a + c.rollups.length, 0);
    expect(total).toBe(200);
  });

  it("carries context rows when there are no rollups", async () => {
    const context = Array.from({ length: 5 }, (_, i) => makeContext(i));
    const chunks = chunkUpload([], context);
    expect(chunks.length).toBe(1);
    expect(chunks[0].context.length).toBe(5);
  });
});

describe("pushToCentral", () => {
  it("issues one POST per chunk with bearer auth + {rollups,context} bodies", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Force >1 chunk via byte padding.
    const rollups = Array.from({ length: 200 }, (_, i) => makeRollup(i, 10 * 1024));
    const res = await pushToCentral(rollups, [makeContext(0)], CFG);

    const expectedChunks = chunkUpload(rollups, [makeContext(0)]).length;
    expect(expectedChunks).toBeGreaterThan(1);
    expect(fetchMock).toHaveBeenCalledTimes(expectedChunks);
    expect(res.chunks).toBe(expectedChunks);
    expect(res.ok).toBe(expectedChunks);
    expect(res.failed).toBe(0);

    let seenRows = 0;
    for (const call of fetchMock.mock.calls) {
      const [url, opts] = call as [string, RequestInit];
      expect(url).toBe("https://central.example/api/ingest");
      expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
      const body = JSON.parse(opts.body as string);
      expect(Array.isArray(body.rollups)).toBe(true);
      expect(Array.isArray(body.context)).toBe(true);
      // Each POST under the 1MB server cap.
      expect(Buffer.byteLength(opts.body as string)).toBeLessThan(1024 * 1024);
      seenRows += body.rollups.length;
    }
    expect(seenRows).toBe(200);
  });

  it("is a no-op when cfg is null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await pushToCentral([makeRollup(0)], [], null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toEqual({ chunks: 0, ok: 0, failed: 0 });
  });

  it("counts failures and does not throw on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const res = await pushToCentral([makeRollup(0)], [], CFG);
    expect(res.failed).toBe(1);
    expect(res.ok).toBe(0);
  });
});

describe("reportToCentral backoff", () => {
  it("no-op without config", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportToCentral([makeRollup(0)], [], null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backs off after a failure (skips the next push until cooldown)", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await reportToCentral([makeRollup(0)], [], CFG);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Immediately try again — should be suppressed by the backoff window.
    await reportToCentral([makeRollup(1)], [], CFG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers + clears backoff on a successful push", async () => {
    let status = 503;
    const fetchMock = vi.fn(async () => new Response("x", { status }));
    vi.stubGlobal("fetch", fetchMock);

    await reportToCentral([makeRollup(0)], [], CFG); // fail → backoff
    _resetUploadBackoff(); // simulate cooldown elapsed
    status = 200;
    await reportToCentral([makeRollup(1)], [], CFG); // success
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Next push goes through (backoff cleared).
    await reportToCentral([makeRollup(2)], [], CFG);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
