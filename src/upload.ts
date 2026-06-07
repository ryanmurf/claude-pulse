import type { Profile } from "./types.js";
import { listProfiles } from "./store.js";
import { tallyProfileFineGrained, type TallyOptions } from "./tokens.js";
import { getAllSessionContextsForProfile, getContextForProfile } from "./context.js";
import { fetchUsage } from "./usage.js";
import { computeGeminiQuotaBuckets } from "./gemini.js";

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

/**
 * A 5h/7d usage snapshot for a profile. Account-level per profile (the window is
 * the subscription's, shared across machines) — the server scopes it to the
 * token's account + profile, latest-poll-wins. machine is metadata only.
 */
export interface UploadSnapshot {
  profile: string;
  five_hour_pct: number | null;
  five_hour_resets_at: string | null;
  seven_day_pct: number | null;
  seven_day_resets_at: string | null;
  context_tokens?: number | null;
  context_pct?: number | null;
  context_session_id?: string | null;
  context_model?: string | null;
  context_effective_limit?: number | null;
  context_last_reset_at?: string | null;
  polled_at?: string | null;
}

/** A gemini_quota bucket. Scoped to the token's account on the server. */
export interface UploadGemini {
  model_id: string;
  remaining_fraction: number;
  remaining_amount: string | null;
  reset_time: string | null;
}

/** The full extended /api/ingest body. All sections optional. */
export interface IngestPayload {
  rollups?: UploadRollup[];
  context?: UploadContext[];
  snapshots?: UploadSnapshot[];
  gemini?: UploadGemini[];
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
 *
 * snapshots + gemini are small + few (one row per profile / per model). They are
 * attached to the FIRST chunk only by the caller so they're sent exactly once,
 * never fanned out across chunks. When there are no rollups/context at all a
 * single empty chunk is still produced so those sections get a POST.
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
 * POST an extended ingest payload (rollups + context + snapshots + gemini) to the
 * central server, chunked to stay under the 1MB ingest cap. rollups + context are
 * chunked as before; snapshots + gemini (small + few) ride on the FIRST chunk
 * exactly once. Each chunk is one POST. Returns the number of chunks that
 * succeeded; never throws (failures are logged so the daemon keeps running).
 *
 * @param cfg pass an explicit config; defaults to reading the env contract.
 */
export async function pushToCentral(
  rollups: UploadRollup[],
  context: UploadContext[],
  cfg: UploadConfig | null = uploadConfig(),
  extra?: { snapshots?: UploadSnapshot[]; gemini?: UploadGemini[] },
): Promise<{ chunks: number; ok: number; failed: number }> {
  if (!cfg) return { chunks: 0, ok: 0, failed: 0 };
  const snapshots = extra?.snapshots ?? [];
  const gemini = extra?.gemini ?? [];
  if (
    rollups.length === 0 &&
    context.length === 0 &&
    snapshots.length === 0 &&
    gemini.length === 0
  ) {
    return { chunks: 0, ok: 0, failed: 0 };
  }

  const url = `${cfg.baseUrl}/api/ingest`;
  const chunks: IngestPayload[] = chunkUpload(rollups, context);
  // Ensure there's at least one chunk to carry snapshots/gemini even when there
  // are no rollups/context rows.
  if (chunks.length === 0) chunks.push({ rollups: [], context: [] });
  // Attach snapshots + gemini to the first chunk only (sent exactly once).
  if (snapshots.length > 0) chunks[0].snapshots = snapshots;
  if (gemini.length > 0) chunks[0].gemini = gemini;
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
  include?: { snapshots?: boolean; gemini?: boolean },
): Promise<{
  rollups: UploadRollup[];
  context: UploadContext[];
  snapshots: UploadSnapshot[];
  gemini: UploadGemini[];
}> {
  const rollups: UploadRollup[] = [];
  const context: UploadContext[] = [];
  const snapshots: UploadSnapshot[] = [];
  let gemini: UploadGemini[] = [];

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

    // Current 5h/7d usage snapshot (account-level per profile).
    if (include?.snapshots) {
      try {
        const usage = await fetchUsage(p);
        const ctx =
          p.vendor === "anthropic-oauth" ? getContextForProfile(p.config_dir) : null;
        snapshots.push({
          profile: p.name,
          five_hour_pct: usage.fiveHourPct,
          five_hour_resets_at: usage.fiveHourResetsAt,
          seven_day_pct: usage.sevenDayPct,
          seven_day_resets_at: usage.sevenDayResetsAt,
          context_tokens: ctx?.context_tokens ?? null,
          context_pct: ctx?.context_pct ?? null,
          context_session_id: ctx?.session_id ?? null,
          context_model: ctx?.model ?? null,
          context_effective_limit: ctx?.effective_context ?? null,
          context_last_reset_at: ctx?.last_reset_at ?? null,
          polled_at: new Date().toISOString(),
        });
      } catch (e) {
        log(`computeUpload: usage snapshot failed for ${p.name}: ${(e as Error).message}`);
      }
    }
  }

  if (include?.gemini) {
    try {
      gemini = await computeGeminiQuotaBuckets();
    } catch (e) {
      log(`computeUpload: gemini quota read failed: ${(e as Error).message}`);
    }
  }

  return { rollups, context, snapshots, gemini };
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
  extra?: { snapshots?: UploadSnapshot[]; gemini?: UploadGemini[] },
): Promise<void> {
  if (!cfg) return;
  if (Date.now() < backoffUntil) return;
  const snapshots = extra?.snapshots ?? [];
  const gemini = extra?.gemini ?? [];
  if (
    rollups.length === 0 &&
    context.length === 0 &&
    snapshots.length === 0 &&
    gemini.length === 0
  )
    return;

  const res = await pushToCentral(rollups, context, cfg, { snapshots, gemini });
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
