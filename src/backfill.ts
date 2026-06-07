import os from "node:os";
import {
  listProfiles,
  resolveAccount,
  DEFAULT_ACCOUNT_IDENTITY,
  upsertTokenRollup,
  upsertTokenUsage,
  upsertContextSession,
} from "./store.js";
import { tallyProfileTokens, tallyProfileFineGrained } from "./tokens.js";
import { getAllSessionContextsForProfile } from "./context.js";

/**
 * Full-history backfill into the LOCAL DB (for the central/tron pod).
 *
 * Runs ONE unlimited (sinceDays:null) tally per local profile and upserts both the
 * coarse (profile,host,day,model) rollup and the fine-grained token_usage grain,
 * tagged host=hostname + account=DEFAULT_ACCOUNT. Idempotent (upsert), so running
 * it twice yields the same rows. Also records current context_sessions once.
 *
 * Gated by the caller (CLAUDE_PULSE_BACKFILL=1). Streams transcripts line-by-line
 * inside the tally so memory stays bounded across thousands of files.
 */

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

export interface BackfillResult {
  profile: string;
  coarse_rows: number;
  fine_rows: number;
  context_rows: number;
}

export async function runLocalBackfill(): Promise<BackfillResult[]> {
  const host = os.hostname();
  const accountId = resolveAccount(DEFAULT_ACCOUNT_IDENTITY).id;
  const profiles = listProfiles();
  const results: BackfillResult[] = [];

  log(`Backfill (local, full-history): starting for ${profiles.length} profile(s) on host ${host}`);

  for (const p of profiles) {
    const r: BackfillResult = { profile: p.name, coarse_rows: 0, fine_rows: 0, context_rows: 0 };
    try {
      // Coarse (profile,host,day,model) rollup — full history.
      const rows = await tallyProfileTokens(p, undefined, { sinceDays: null });
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
      r.coarse_rows = rows.length;

      // Fine-grained token_usage — full history.
      const fineRows = await tallyProfileFineGrained(p, undefined, { sinceDays: null });
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
      r.fine_rows = fineRows.length;

      // Current context_sessions once (anthropic-oauth profiles only).
      if (p.vendor === "anthropic-oauth") {
        for (const s of getAllSessionContextsForProfile(p.config_dir)) {
          upsertContextSession({
            account_id: accountId,
            profile: p.name,
            machine: host,
            session_id: s.session_id,
            model: s.model,
            settings_json: "{}",
            context_tokens: s.context_tokens,
            context_pct: s.context_pct,
            effective_limit: s.effective_context,
            last_active_at: s.mtime,
          });
          r.context_rows++;
        }
      }

      log(
        `Backfill (local): ${p.name} — ${r.coarse_rows} coarse row(s), ${r.fine_rows} fine row(s), ${r.context_rows} context session(s)`,
      );
    } catch (e) {
      log(`Backfill (local): ${p.name} failed: ${(e as Error).message}`);
    }
    results.push(r);
  }

  const totFine = results.reduce((a, b) => a + b.fine_rows, 0);
  log(`Backfill (local): done — ${totFine} fine row(s) across ${profiles.length} profile(s)`);
  return results;
}
