import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PollResult, Profile, AlertEvent } from "./types.js";
import {
  insertSnapshot,
  listProfiles,
  getProfile,
  getLastSuccessfulSnapshot,
  upsertContextOnLatestSnapshot,
  upsertTokenRollup,
  upsertTokenUsage,
  upsertContextSession,
  sweepStaleContextSessions,
  resolveAccount,
  localAccountId,
  DEFAULT_ACCOUNT_IDENTITY,
  type ContextSnapshotFields,
} from "./store.js";
import { checkAlerts } from "./alerts.js";
import { fetchUsage } from "./usage.js";
import { getAllSessionContextsForProfile, getContextForProfile, type ContextReadResult } from "./context.js";
import { tallyProfileTokens, tallyProfileFineGrained } from "./tokens.js";
import {
  reportToCentral,
  uploadConfig,
  type UploadRollup,
  type UploadContext,
} from "./upload.js";

const activeTimers = new Map<string, ReturnType<typeof setInterval>>();
const pendingResumes = new Map<string, ReturnType<typeof setTimeout>>();
let contextTimer: ReturnType<typeof setInterval> | undefined;
let tokenRollupTimer: ReturnType<typeof setInterval> | undefined;
const CONTEXT_POLL_INTERVAL_MS = 30_000; // 30s — JSONL-scan is cheap (tail read)
const TOKEN_ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // 1h default
// How many trailing days to recompute each run — catches late JSONL writes.
const TOKEN_ROLLUP_LOOKBACK_DAYS = 2;

let mcpServerInstance: McpServer | undefined;

/**
 * Set the MCP server instance so the poller can push channel notifications
 * when alerts are triggered.
 */
export function setMcpServer(server: McpServer): void {
  mcpServerInstance = server;
}

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

/**
 * Check whether an error message indicates rate-limit / usage-window exhaustion.
 */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const text = msg.toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("usage limit") ||
    text.includes("too many requests") ||
    text.includes("429") ||
    text.includes("quota exceeded") ||
    text.includes("resource_exhausted") ||
    text.includes("overloaded") ||
    text.includes("over capacity")
  );
}

/**
 * Pick the earliest future resets_at from a set of candidates.
 */
function earliestFutureReset(...candidates: (string | null | undefined)[]): string | null {
  const now = Date.now();
  let best: string | null = null;
  let bestTime = Infinity;
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (t > now && t < bestTime) {
      best = c;
      bestTime = t;
    }
  }
  return best;
}

/**
 * Schedule a channel notification for when a usage window resets.
 * Deduplicates by profile + resetsAt so the same window isn't scheduled twice.
 */
export function scheduleWindowResume(profile: string, resetsAt: string): void {
  const key = `${profile}:${resetsAt}`;
  if (pendingResumes.has(key)) return;

  const resetTime = new Date(resetsAt).getTime();
  const resumeTime = resetTime + 60_000; // 1 minute after reset
  const delay = resumeTime - Date.now();

  if (delay <= 0) {
    log(`Reset time already passed for ${profile}, firing resume now`);
    pushChannelResume(profile, resetsAt).catch((e) =>
      log(`Failed to push immediate resume for ${profile}: ${e}`)
    );
    return;
  }

  log(
    `Scheduled window resume for ${profile} at ${new Date(resumeTime).toISOString()} (in ${Math.round(delay / 60_000)} min)`
  );

  const timer = setTimeout(async () => {
    pendingResumes.delete(key);
    try {
      await pushChannelResume(profile, resetsAt);
    } catch (e) {
      log(`Failed to push resume for ${profile}: ${e}`);
    }
  }, delay);

  timer.unref();
  pendingResumes.set(key, timer);
}

/**
 * Send a channel notification telling Claude Code the usage window has reset.
 */
async function pushChannelResume(profile: string, resetsAt: string): Promise<void> {
  if (!mcpServerInstance) return;
  try {
    await (mcpServerInstance.server as any).notification({
      method: "notifications/claude/channel",
      params: {
        content: `Usage window has reset for ${profile}. You may resume.`,
        meta: {
          event_type: "window_reset",
          profile,
          resets_at: resetsAt,
        },
      },
    });
    log(`Window reset notification pushed for ${profile}`);
  } catch (err) {
    log(`Failed to push window reset notification for ${profile}: ${err}`);
  }
}

/**
 * Cancel pending resume timers. If profile is given, only cancel that profile's timers.
 */
export function cancelPendingResumes(profile?: string): void {
  for (const [key, timer] of pendingResumes) {
    if (!profile || key.startsWith(`${profile}:`)) {
      clearTimeout(timer);
      pendingResumes.delete(key);
      log(`Cancelled pending resume: ${key}`);
    }
  }
}

/**
 * Push a channel notification for a triggered alert event.
 */
async function pushChannelAlert(evt: AlertEvent, profile: string, resetsAt: string | null): Promise<void> {
  if (!mcpServerInstance) return;

  const meta: Record<string, string> = {
    alert_type: evt.alert_type,
    profile,
    alert_id: String(evt.id),
  };

  if (evt.current_value !== null) {
    meta.current_value = evt.current_value.toFixed(1);
  }
  if (evt.threshold !== null) {
    meta.threshold = String(evt.threshold);
  }
  if (resetsAt) {
    meta.resets_at = resetsAt;
  }

  try {
    await (mcpServerInstance.server as any).notification({
      method: "notifications/claude/channel",
      params: {
        content: evt.message,
        meta,
      },
    });
    log(`Channel notification pushed for alert ${evt.id}: ${evt.message}`);
  } catch (err) {
    log(`Failed to push channel notification for alert ${evt.id}: ${err}`);
  }
}

/**
 * Determine the relevant reset time for an alert event based on its type.
 */
function getResetsAt(
  evt: AlertEvent,
  fiveHourResets: string | null,
  sevenDayResets: string | null
): string | null {
  if (evt.alert_type === "five_hour_threshold") return fiveHourResets;
  if (evt.alert_type === "seven_day_threshold") return sevenDayResets;
  return null;
}

function contextResultToFields(r: ContextReadResult | null): ContextSnapshotFields | null {
  if (!r) return null;
  return {
    context_tokens: r.context_tokens,
    context_pct: r.context_pct,
    context_session_id: r.session_id,
    context_model: r.model,
    context_effective_limit: r.effective_context,
    context_last_reset_at: r.last_reset_at,
  };
}

export async function pollProfile(profileName: string): Promise<PollResult> {
  const profile = getProfile(profileName);
  if (!profile) {
    return { profile: profileName, success: false, error: "Profile not found" };
  }

  try {
    log(`Polling profile: ${profile.name} (config_dir: ${profile.config_dir})`);

    const usage = await fetchUsage(profile);

    // Read current context-window state from the most recent Claude Code session JSONL.
    // Anthropic-oauth profiles only.
    let ctxFields: ContextSnapshotFields | null = null;
    if (profile.vendor === "anthropic-oauth") {
      try {
        ctxFields = contextResultToFields(getContextForProfile(profile.config_dir));
      } catch (e) {
        log(`Context read failed for ${profile.name}: ${(e as Error).message}`);
      }
    }

    const snapshot = insertSnapshot(
      profile.name,
      usage.fiveHourPct,
      usage.fiveHourResetsAt,
      usage.sevenDayPct,
      usage.sevenDayResetsAt,
      usage.raw,
      ctxFields
    );

    log(
      `Poll complete for ${profile.name}: 5h=${usage.fiveHourPct}%, 7d=${usage.sevenDayPct}%`
    );

    // Check alerts after successful poll (local daemon account).
    const alertEvents = checkAlerts(localAccountId(), profile.name, snapshot);
    for (const evt of alertEvents) {
      const resetsAt = getResetsAt(evt, usage.fiveHourResetsAt, usage.sevenDayResetsAt);
      await pushChannelAlert(evt, profile.name, resetsAt);
    }

    return { profile: profile.name, success: true, snapshot };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Poll failed for ${profile.name}: ${errorMsg}`);

    // If rate-limited, schedule a resume notification for when the window resets
    if (isRateLimitError(err)) {
      log(`Rate-limit detected for ${profile.name}, looking for reset time`);
      const lastGood = getLastSuccessfulSnapshot(profile.name);
      const resetsAt = earliestFutureReset(
        lastGood?.five_hour_resets_at,
        lastGood?.seven_day_resets_at,
      );
      if (resetsAt) {
        scheduleWindowResume(profile.name, resetsAt);
      } else {
        log(`No future resets_at found for ${profile.name}, cannot schedule resume`);
      }
    }

    // Record a snapshot with null usage values on error, but still try to capture context
    let ctxFields: ContextSnapshotFields | null = null;
    if (profile.vendor === "anthropic-oauth") {
      try {
        ctxFields = contextResultToFields(getContextForProfile(profile.config_dir));
      } catch (e) {
        log(`Context read failed during error path for ${profile.name}: ${(e as Error).message}`);
      }
    }
    const snapshot = insertSnapshot(
      profile.name,
      null,
      null,
      null,
      null,
      JSON.stringify({ error: errorMsg }),
      ctxFields
    );

    // Check alerts after failed poll (auth_failure detection)
    const alertEvents = checkAlerts(localAccountId(), profile.name, snapshot);
    for (const evt of alertEvents) {
      await pushChannelAlert(evt, profile.name, null);
    }

    return {
      profile: profile.name,
      success: false,
      error: errorMsg,
      snapshot,
    };
  }
}

export async function pollAllProfiles(): Promise<PollResult[]> {
  const profiles = listProfiles();
  const results: PollResult[] = [];
  for (const p of profiles) {
    const result = await pollProfile(p.name);
    results.push(result);
  }
  return results;
}

function startProfileTimer(profile: Profile): void {
  // Clear existing timer if any
  stopProfileTimer(profile.name);

  const intervalMs = profile.poll_interval_minutes * 60 * 1000;
  log(
    `Starting poll timer for ${profile.name} every ${profile.poll_interval_minutes} min`
  );

  // Do an initial poll
  pollProfile(profile.name).catch((err) => {
    log(`Initial poll error for ${profile.name}: ${err}`);
  });

  // Set up recurring interval
  const timer = setInterval(() => {
    pollProfile(profile.name).catch((err) => {
      log(`Poll error for ${profile.name}: ${err}`);
    });
  }, intervalMs);

  // Ensure the timer doesn't prevent Node from exiting
  timer.unref();

  activeTimers.set(profile.name, timer);
}

function stopProfileTimer(name: string): void {
  const existing = activeTimers.get(name);
  if (existing) {
    clearInterval(existing);
    activeTimers.delete(name);
    log(`Stopped poll timer for ${name}`);
  }
}

export function startAllPollers(): void {
  const profiles = listProfiles();
  for (const p of profiles) {
    startProfileTimer(p);
  }
  log(`Started pollers for ${profiles.length} profile(s)`);
}

export function restartPoller(profileName: string): void {
  const profile = getProfile(profileName);
  if (profile) {
    startProfileTimer(profile);
  }
}

export function stopPoller(profileName: string): void {
  stopProfileTimer(profileName);
  cancelPendingResumes(profileName);
}

export function stopAllPollers(): void {
  for (const name of activeTimers.keys()) {
    stopProfileTimer(name);
  }
  cancelPendingResumes();
  stopContextPoller();
  stopTokenRollup();
  log("All pollers stopped");
}

// ── Context-only polling loop ──────────────────────────────────────────────
// Reads each profile's current-session JSONL on a fast cadence (30s) and
// updates context_* fields on the latest snapshot. Cheap (tail read).

export async function pollContextOnce(): Promise<void> {
  const profiles = listProfiles();
  const accountId = resolveAccount(DEFAULT_ACCOUNT_IDENTITY).id;
  const machine = os.hostname();
  const upCfg = uploadConfig();
  const uploadContext: UploadContext[] = [];
  for (const p of profiles) {
    if (p.vendor !== "anthropic-oauth") continue;
    try {
      // Single most-recent session drives the snapshot context_* fields +
      // context_threshold alert (back-compat with the per-profile view).
      const ctx = getContextForProfile(p.config_dir);
      if (ctx) {
        const fields: ContextSnapshotFields = {
          context_tokens: ctx.context_tokens,
          context_pct: ctx.context_pct,
          context_session_id: ctx.session_id,
          context_model: ctx.model,
          context_effective_limit: ctx.effective_context,
          context_last_reset_at: ctx.last_reset_at,
        };
        const snapshot = upsertContextOnLatestSnapshot(p.name, fields, accountId);
        // Evaluate ONLY context alerts on this fast loop — 5h/7d are handled by the slow loop.
        const alertEvents = checkAlerts(accountId, p.name, snapshot, ["context_threshold"]);
        for (const evt of alertEvents) {
          await pushChannelAlert(evt, p.name, null);
        }
      }

      // Multi-session: populate context_sessions for every live session on
      // this machine, tagged with hostname + last_active_at (the JSONL mtime).
      const sessions = getAllSessionContextsForProfile(p.config_dir);
      for (const s of sessions) {
        upsertContextSession({
          account_id: accountId,
          profile: p.name,
          machine,
          session_id: s.session_id,
          model: s.model,
          settings_json: "{}",
          context_tokens: s.context_tokens,
          context_pct: s.context_pct,
          effective_limit: s.effective_context,
          last_active_at: s.mtime,
        });
        if (upCfg) {
          uploadContext.push({
            profile: p.name,
            session_id: s.session_id,
            model: s.model,
            context_tokens: s.context_tokens,
            context_pct: s.context_pct,
            effective_limit: s.effective_context,
            last_active_at: s.mtime,
          });
        }
      }
    } catch (e) {
      log(`Context poll failed for ${p.name}: ${(e as Error).message}`);
    }
  }
  // Periodically drop sessions that have gone stale (>1 day inactive).
  try {
    sweepStaleContextSessions();
  } catch (e) {
    log(`Context sweep failed: ${(e as Error).message}`);
  }

  // Continuous reporting: push current context to central after local upserts.
  if (upCfg && uploadContext.length > 0) {
    try {
      await reportToCentral([], uploadContext, upCfg);
    } catch (e) {
      log(`Context poll: central report error: ${(e as Error).message}`);
    }
  }
}

export function startContextPoller(intervalMs: number = CONTEXT_POLL_INTERVAL_MS): void {
  stopContextPoller();
  // Run immediately then on interval
  pollContextOnce().catch((e) => log(`Initial context poll error: ${e}`));
  contextTimer = setInterval(() => {
    pollContextOnce().catch((e) => log(`Context poll error: ${e}`));
  }, intervalMs);
  contextTimer.unref();
  log(`Context poller started (every ${Math.round(intervalMs / 1000)}s)`);
}

export function stopContextPoller(): void {
  if (contextTimer) {
    clearInterval(contextTimer);
    contextTimer = undefined;
    log("Context poller stopped");
  }
}

// ── Token rollup loop ──────────────────────────────────────────────────────
// On startup and every N hours, scan each profile's transcripts and upsert
// per-(day, model) token rollups keyed by this machine's hostname. Recomputes
// the trailing few days each run so late writes are captured.

function lookbackSinceDay(days: number): string {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Compute + upsert local token rollups for all profiles. Guarded per-profile so
 * one bad transcript can't abort the rest. `source='local'`, host=os.hostname().
 */
export async function runTokenRollupOnce(
  lookbackDays: number = TOKEN_ROLLUP_LOOKBACK_DAYS,
): Promise<void> {
  const host = os.hostname();
  const accountId = resolveAccount(DEFAULT_ACCOUNT_IDENTITY).id;
  const sinceDay = lookbackSinceDay(lookbackDays);
  const profiles = listProfiles();
  // When central-reporting is configured, collect the just-computed fine-grained
  // rows to push AFTER the local upserts (local DB is always written first).
  const upCfg = uploadConfig();
  const uploadRollups: UploadRollup[] = [];
  for (const p of profiles) {
    try {
      // Legacy coarse (profile,host,day,model) rollup — kept for back-compat.
      const rows = await tallyProfileTokens(p, sinceDay);
      for (const row of rows) {
        upsertTokenRollup({
          profile: p.name,
          host,
          day: row.day,
          model: row.model,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          cache_creation_tokens: row.cache_creation_tokens,
          cache_read_tokens: row.cache_read_tokens,
          cost_usd: row.cost_usd,
          source: "local",
        });
      }
      if (rows.length > 0) {
        log(`Token rollup: ${p.name} upserted ${rows.length} (day,model) row(s) for host ${host}`);
      }

      // Fine-grained token_usage for the local/default account.
      const fineRows = await tallyProfileFineGrained(p, sinceDay);
      for (const fr of fineRows) {
        upsertTokenUsage({
          account_id: accountId,
          profile: p.name,
          machine: host,
          session_id: fr.session_id,
          model: fr.model,
          settings_hash: fr.settings_hash,
          settings_json: fr.settings_json,
          day: fr.day,
          tokens_in: fr.tokens_in,
          tokens_out: fr.tokens_out,
          cache_write_5m: fr.cache_write_5m,
          cache_write_1h: fr.cache_write_1h,
          cache_read: fr.cache_read,
          source: "local",
        });
      }
      if (fineRows.length > 0) {
        log(`Token usage(fine): ${p.name} upserted ${fineRows.length} grain row(s) for machine ${host}`);
      }

      // Stage just-computed rows for central reporting (pushed after local writes).
      if (upCfg) {
        for (const fr of fineRows) {
          uploadRollups.push({
            profile: p.name,
            session_id: fr.session_id,
            day: fr.day,
            model: fr.model,
            settings: safeParseSettings(fr.settings_json),
            tokens_in: fr.tokens_in,
            tokens_out: fr.tokens_out,
            cache_write_5m: fr.cache_write_5m,
            cache_write_1h: fr.cache_write_1h,
            cache_read: fr.cache_read,
          });
        }
      }
    } catch (e) {
      log(`Token rollup failed for ${p.name}: ${(e as Error).message}`);
    }
  }

  // Continuous reporting: push the just-computed rollups to central (no-op unless
  // CLAUDE_PULSE_UPLOAD_TO + CLAUDE_PULSE_INGEST_TOKEN are set). Local writes above
  // already happened; a push failure only logs + backs off, never crashes.
  if (upCfg && uploadRollups.length > 0) {
    try {
      await reportToCentral(uploadRollups, [], upCfg);
    } catch (e) {
      log(`Token rollup: central report error: ${(e as Error).message}`);
    }
  }
}

function safeParseSettings(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function startTokenRollup(intervalMs: number = TOKEN_ROLLUP_INTERVAL_MS): void {
  stopTokenRollup();
  // Run once on startup (don't block), then on interval.
  runTokenRollupOnce().catch((e) => log(`Initial token rollup error: ${e}`));
  tokenRollupTimer = setInterval(() => {
    runTokenRollupOnce().catch((e) => log(`Token rollup error: ${e}`));
  }, intervalMs);
  tokenRollupTimer.unref();
  log(`Token rollup loop started (every ${Math.round(intervalMs / 3_600_000)}h)`);
}

export function stopTokenRollup(): void {
  if (tokenRollupTimer) {
    clearInterval(tokenRollupTimer);
    tokenRollupTimer = undefined;
    log("Token rollup loop stopped");
  }
}
