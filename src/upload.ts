import type { Profile } from "./types.js";
import { listProfiles } from "./store.js";
import { tallyProfileFineGrained, type TallyOptions } from "./tokens.js";
import { getAllSessionContextsForProfile } from "./context.js";

/**
 * Central-reporting client.
 *
 * Shared by three callers:
 *   - one-shot upload mode (`CLAUDE_PULSE_MODE=upload`) in index.ts
 *   - the continuous reporter wired into the long-running rollup + context loops
 *   - the upload-backfill path
 *
 * Gated entirely on two env vars:
 *   - CLAUDE_PULSE_UPLOAD_TO     — central base URL (e.g. https://pulse.example)
 *   - CLAUDE_PULSE_INGEST_TOKEN  — this machine's bearer (minted in the dashboard)
 *
 * When either is unset, `uploadConfig()` returns null and every caller is a no-op
 * (so the central pod, which ingests its own data locally, never uploads to itself).
 */

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

// The /api/ingest body shape. account + machine are inferred server-side from the
// ingest token — we never send them.
export interface UploadRollup {
  profile: string;
  session_id: string;
  day: string;
  model: string;
  settings: Record<string, unknown>;
  tokens_in: number;
  tokens_out: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export interface UploadContext {
  profile: string;
  session_id: string;
  model: string | null;
  context_tokens: number | null;
  context_pct: number | null;
  effective_limit: number | null;
  last_active_at: string;
}

export interface UploadConfig {
  baseUrl: string;
  ingestToken: string;
}

/** Read the upload env contract. Returns null when not configured (the common case). */
export function uploadConfig(): UploadConfig | null {
  const target = process.env.CLAUDE_PULSE_UPLOAD_TO;
  const ingestToken = process.env.CLAUDE_PULSE_INGEST_TOKEN;
  if (!target || !ingestToken) return null;
  return { baseUrl: target.replace(/\/$/, ""), ingestToken };
}

// The server caps /api/ingest bodies at 1MB. Stay comfortably under that so a
// fat day can't 413. We chunk by ROW COUNT, sized so even wide rows fit, and
// additionally split any chunk whose serialized size still exceeds the cap.
const SERVER_CAP_BYTES = 1024 * 1024;
// Leave headroom for the JSON envelope + any field we under-estimate.
export const INGEST_SAFE_BYTES = 900 * 1024;
// Coarse row batch ceiling — keeps each POST small even if rows are tiny.
export const MAX_ROWS_PER_CHUNK = 500;

function bodyBytes(rollups: UploadRollup[], context: UploadContext[]): number {
  return Buffer.byteLength(JSON.stringify({ rollups, context }));
}

/**
 * Split rollups + context into chunks whose serialized {rollups,context} body
 * stays under INGEST_SAFE_BYTES (and the server's 1MB cap). Strategy:
 *   1. Greedily pack by row count (MAX_ROWS_PER_CHUNK) AND running byte estimate.
 *   2. If a single row is somehow still over the cap, it ships alone (best effort
 *      — the server will reject it with 413, which we log rather than crash on).
 * Context rows ride along in the same chunks (they're small + few); a dedicated
 * trailing chunk carries any leftover context when there are no rollups.
 */
export function chunkUpload(
  rollups: UploadRollup[],
  context: UploadContext[],
): Array<{ rollups: UploadRollup[]; context: UploadContext[] }> {
  const chunks: Array<{ rollups: UploadRollup[]; context: UploadContext[] }> = [];

  let curR: UploadRollup[] = [];
  let curC: UploadContext[] = [];

  const flush = (): void => {
    if (curR.length === 0 && curC.length === 0) return;
    chunks.push({ rollups: curR, context: curC });
    curR = [];
    curC = [];
  };

  for (const r of rollups) {
    // Would adding this row blow the row cap or the byte cap? Flush first.
    if (
      curR.length > 0 &&
      (curR.length >= MAX_ROWS_PER_CHUNK ||
        bodyBytes([...curR, r], curC) > INGEST_SAFE_BYTES)
    ) {
      flush();
    }
    curR.push(r);
  }

  // Pack context into the chunks: attach to the current open chunk, splitting as needed.
  for (const c of context) {
    if (
      (curR.length > 0 || curC.length > 0) &&
      (curC.length + curR.length >= MAX_ROWS_PER_CHUNK ||
        bodyBytes(curR, [...curC, c]) > INGEST_SAFE_BYTES)
    ) {
      flush();
    }
    curC.push(c);
  }

  flush();
  return chunks;
}

/**
 * POST rollups + current context to the central server, chunked to stay under
 * the 1MB ingest cap. Each chunk is one POST. Returns the number of chunks that
 * succeeded; never throws (failures are logged so the daemon keeps running).
 *
 * @param cfg pass an explicit config; defaults to reading the env contract.
 */
export async function pushToCentral(
  rollups: UploadRollup[],
  context: UploadContext[],
  cfg: UploadConfig | null = uploadConfig(),
): Promise<{ chunks: number; ok: number; failed: number }> {
  if (!cfg) return { chunks: 0, ok: 0, failed: 0 };
  if (rollups.length === 0 && context.length === 0) {
    return { chunks: 0, ok: 0, failed: 0 };
  }

  const url = `${cfg.baseUrl}/api/ingest`;
  const chunks = chunkUpload(rollups, context);
  let ok = 0;
  let failed = 0;

  for (const chunk of chunks) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.ingestToken}`,
        },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await resp.text();
      if (!resp.ok) {
        failed++;
        log(`pushToCentral: ingest HTTP ${resp.status}: ${text.slice(0, 200)}`);
      } else {
        ok++;
      }
    } catch (e) {
      failed++;
      log(`pushToCentral: POST failed: ${(e as Error).message}`);
    }
  }

  return { chunks: chunks.length, ok, failed };
}

/**
 * Compute the fine-grained rollups + current context for the given profiles
 * (defaults to all local profiles). `opts` is passed straight through to the
 * tally — `{ sinceDays: null }` does a full-history backfill scan.
 */
export async function computeUpload(
  sinceDay: string | undefined,
  opts?: TallyOptions,
  profiles?: Profile[],
): Promise<{ rollups: UploadRollup[]; context: UploadContext[] }> {
  const rollups: UploadRollup[] = [];
  const context: UploadContext[] = [];

  const targetProfiles = profiles ?? (await listProfiles());
  for (const p of targetProfiles) {
    try {
      const rows = await tallyProfileFineGrained(p, sinceDay, opts);
      for (const r of rows) {
        rollups.push({
          profile: p.name,
          session_id: r.session_id,
          day: r.day,
          model: r.model,
          settings: JSON.parse(r.settings_json || "{}"),
          tokens_in: r.tokens_in,
          tokens_out: r.tokens_out,
          cache_write_5m: r.cache_write_5m,
          cache_write_1h: r.cache_write_1h,
          cache_read: r.cache_read,
        });
      }
    } catch (e) {
      log(`computeUpload: tally failed for ${p.name}: ${(e as Error).message}`);
    }

    // Current live per-session context (anthropic-oauth profiles only).
    if (p.vendor === "anthropic-oauth") {
      try {
        for (const s of getAllSessionContextsForProfile(p.config_dir)) {
          context.push({
            profile: p.name,
            session_id: s.session_id,
            model: s.model,
            context_tokens: s.context_tokens,
            context_pct: s.context_pct,
            effective_limit: s.effective_context,
            last_active_at: s.mtime,
          });
        }
      } catch (e) {
        log(`computeUpload: context read failed for ${p.name}: ${(e as Error).message}`);
      }
    }
  }

  return { rollups, context };
}

// ── Continuous-reporting backoff ─────────────────────────────────────────────
// The long-running loops call reportToCentral() after each local computation.
// A down server must not turn into a hot-loop: after a failed push we back off
// (exponential, capped) and skip pushes until the cooldown elapses.

const BACKOFF_BASE_MS = 30_000; // 30s after first failure
const BACKOFF_MAX_MS = 15 * 60_000; // cap at 15m
let backoffUntil = 0;
let consecutiveFailures = 0;

/** Test hook: reset the backoff state. */
export function _resetUploadBackoff(): void {
  backoffUntil = 0;
  consecutiveFailures = 0;
}

/**
 * Continuous-reporting entry point used by the rollup + context loops. No-op when
 * upload is unconfigured. Honors a backoff window so a down central server doesn't
 * cause a hot retry loop. Never throws.
 *
 * Pass pre-computed rows (the loops already compute them for the LOCAL write, so
 * we reuse those rather than re-scanning transcripts).
 */
export async function reportToCentral(
  rollups: UploadRollup[],
  context: UploadContext[],
  cfg: UploadConfig | null = uploadConfig(),
): Promise<void> {
  if (!cfg) return;
  if (Date.now() < backoffUntil) return;
  if (rollups.length === 0 && context.length === 0) return;

  const res = await pushToCentral(rollups, context, cfg);
  if (res.failed > 0 && res.ok === 0) {
    // Whole push failed — back off.
    consecutiveFailures++;
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1),
      BACKOFF_MAX_MS,
    );
    backoffUntil = Date.now() + delay;
    log(
      `reportToCentral: push failed (${res.failed}/${res.chunks} chunks); backing off ${Math.round(delay / 1000)}s`,
    );
  } else {
    if (consecutiveFailures > 0) {
      log(`reportToCentral: recovered after ${consecutiveFailures} failure(s)`);
    }
    consecutiveFailures = 0;
    backoffUntil = 0;
  }
}
