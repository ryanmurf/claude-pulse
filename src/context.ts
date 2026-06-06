import fs from "node:fs";
import path from "node:path";

/**
 * Context-window monitor for Claude Code session JSONL files.
 *
 * For each profile (= a CLAUDE_CONFIG_DIR), find the most-recently-active
 * session JSONL across all `<config_dir>/projects/<slug>/*.jsonl`, then read
 * the tail of that file to extract:
 *   - the last assistant message's `usage` block (input + cache_creation + cache_read = current context window)
 *   - the most recent `compact_boundary` system entry (last reset)
 *
 * We deliberately compute "context_tokens" as the size of the most recent
 * assistant turn's full input window (input_tokens + cache_creation + cache_read),
 * because that's what Claude Code's `/context` command shows and what predicts
 * the next auto-compact trigger. (Summing `input_tokens` across the whole
 * session under-counts dramatically in cache-heavy flows.)
 */

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

// Model -> effective context window (tokens). Default 200_000.
export const MODEL_LIMITS: Record<string, number> = {
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-opus-4-7-1m": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-1": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-1": 200_000,
};

export const DEFAULT_CONTEXT_LIMIT = 200_000;

export function effectiveContextForModel(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  // Strip suffixes like -20250101 etc.
  const normalised = model.toLowerCase();
  if (MODEL_LIMITS[normalised]) return MODEL_LIMITS[normalised];
  // Try prefix match against known keys
  for (const [k, v] of Object.entries(MODEL_LIMITS)) {
    if (normalised.startsWith(k.toLowerCase())) return v;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

export interface ContextReadResult {
  /** Absolute path to JSONL we read */
  jsonl_path: string;
  /** sessionId parsed from filename (uuid) or message */
  session_id: string;
  /** Total context-window size at the latest assistant turn (input + cache_creation + cache_read) */
  context_tokens: number;
  /** Effective limit for the latest model in this session */
  effective_context: number;
  /** % used */
  context_pct: number;
  /** Model identifier from latest assistant message */
  model: string | null;
  /** ISO timestamp of the latest compact_boundary (null if none) */
  last_reset_at: string | null;
  /** Heuristic: are we approaching auto-compact threshold? */
  tokens_until_compact_recommended: number;
  /** Best-effort modification time of the JSONL (ISO) */
  mtime: string;
}

/**
 * Find the most-recently-modified session JSONL across all
 * `<configDir>/projects/<slug>/*.jsonl` files. Subagent / tool-result
 * subdirectories are ignored — they belong to a parent session.
 */
export function findCurrentSessionJsonl(configDir: string): string | null {
  const projectsDir = path.join(configDir, "projects");
  let projectSlugs: string[];
  try {
    projectSlugs = fs.readdirSync(projectsDir);
  } catch (e) {
    log(`No projects dir under ${configDir}: ${(e as Error).message}`);
    return null;
  }

  let best: { path: string; mtime: number } | null = null;
  for (const slug of projectSlugs) {
    const slugPath = path.join(projectsDir, slug);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(slugPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      // Top-level .jsonl files only — skip subdirs (subagents/, tool-results/)
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".jsonl")) continue;
      const full = path.join(slugPath, ent.name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const mtime = st.mtimeMs;
      if (!best || mtime > best.mtime) best = { path: full, mtime };
    }
  }
  return best ? best.path : null;
}

interface JsonlScanState {
  latestAssistantUsage: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  } | null;
  latestModel: string | null;
  latestCompactBoundaryTs: string | null;
  latestSessionId: string | null;
}

/**
 * Parse a JSONL file (or its tail) and extract the latest assistant usage,
 * latest model, and latest compact_boundary timestamp. We read the whole
 * file when small (< TAIL_BYTES) and only the tail when large, which keeps
 * polls O(constant) for 100MB+ sessions.
 *
 * Returns null if the file can't be read or has no usable data.
 */
const TAIL_BYTES = 256 * 1024; // 256 KB tail covers many turns of usage

export function readJsonlContext(jsonlPath: string): ContextReadResult | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(jsonlPath);
  } catch (e) {
    log(`stat failed for ${jsonlPath}: ${(e as Error).message}`);
    return null;
  }
  if (st.size === 0) {
    return null;
  }

  // Read tail (or full file)
  let buf: string;
  try {
    if (st.size <= TAIL_BYTES) {
      buf = fs.readFileSync(jsonlPath, "utf8");
    } else {
      const fd = fs.openSync(jsonlPath, "r");
      try {
        const chunk = Buffer.alloc(TAIL_BYTES);
        const start = st.size - TAIL_BYTES;
        const bytesRead = fs.readSync(fd, chunk, 0, TAIL_BYTES, start);
        buf = chunk.subarray(0, bytesRead).toString("utf8");
        // Drop the first (possibly partial) line — we may have started mid-line
        const firstNl = buf.indexOf("\n");
        if (firstNl >= 0) buf = buf.slice(firstNl + 1);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (e) {
    log(`read failed for ${jsonlPath}: ${(e as Error).message}`);
    return null;
  }

  const state: JsonlScanState = {
    latestAssistantUsage: null,
    latestModel: null,
    latestCompactBoundaryTs: null,
    latestSessionId: null,
  };

  // Walk lines forward; later assistant messages overwrite earlier.
  const lines = buf.split("\n");
  for (const line of lines) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      // partial / corrupted line — skip silently
      continue;
    }
    if (typeof d !== "object" || d === null) continue;

    if (d.sessionId && typeof d.sessionId === "string") {
      state.latestSessionId = d.sessionId;
    }
    if (d.type === "system" && d.subtype === "compact_boundary") {
      if (typeof d.timestamp === "string") {
        state.latestCompactBoundaryTs = d.timestamp;
      }
    }
    const msg = d.message;
    if (msg && typeof msg === "object" && msg.usage && typeof msg.usage === "object") {
      // Only assistant messages have usage; user messages do not in this format
      if (msg.role === "assistant" || d.type === "assistant") {
        state.latestAssistantUsage = msg.usage;
        if (typeof msg.model === "string") {
          state.latestModel = msg.model;
        }
      }
    }
  }

  if (!state.latestAssistantUsage) {
    // No assistant turns recorded yet (e.g. brand-new session, or pre-compact tail)
    // Still useful to return — context is effectively 0.
    const model = state.latestModel;
    const limit = effectiveContextForModel(model);
    return {
      jsonl_path: jsonlPath,
      session_id: state.latestSessionId ?? path.basename(jsonlPath, ".jsonl"),
      context_tokens: 0,
      effective_context: limit,
      context_pct: 0,
      model,
      last_reset_at: state.latestCompactBoundaryTs,
      tokens_until_compact_recommended: Math.max(0, Math.floor(limit * 0.75)),
      mtime: st.mtime.toISOString(),
    };
  }

  const u = state.latestAssistantUsage;
  const ctx =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const model = state.latestModel;
  const limit = effectiveContextForModel(model);
  const pct = limit > 0 ? (ctx / limit) * 100 : 0;
  const compactRecAt = Math.floor(limit * 0.75);
  const remaining = Math.max(0, compactRecAt - ctx);

  return {
    jsonl_path: jsonlPath,
    session_id: state.latestSessionId ?? path.basename(jsonlPath, ".jsonl"),
    context_tokens: ctx,
    effective_context: limit,
    context_pct: Math.round(pct * 100) / 100,
    model,
    last_reset_at: state.latestCompactBoundaryTs,
    tokens_until_compact_recommended: remaining,
    mtime: st.mtime.toISOString(),
  };
}

/**
 * Convenience: full pipeline — find current session for a profile config_dir,
 * read context. Returns null if no session found.
 */
export function getContextForProfile(configDir: string): ContextReadResult | null {
  // Expand ~
  let dir = configDir;
  if (dir.startsWith("~/")) {
    dir = path.join(process.env.HOME || "", dir.slice(2));
  }
  const jsonl = findCurrentSessionJsonl(dir);
  if (!jsonl) return null;
  return readJsonlContext(jsonl);
}

/**
 * Read context for ALL recently-active top-level session JSONLs under a
 * profile's config_dir (not just the single most-recent one). A machine may
 * run several concurrent sessions; each becomes its own context_session.
 *
 * @param maxAgeMs only consider session files modified within this window
 *                 (default 24h) so we don't resurrect long-dead sessions.
 */
export function getAllSessionContextsForProfile(
  configDir: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): ContextReadResult[] {
  let dir = configDir;
  if (dir.startsWith("~/")) {
    dir = path.join(process.env.HOME || "", dir.slice(2));
  }
  const projectsDir = path.join(dir, "projects");
  let slugs: string[];
  try {
    slugs = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - maxAgeMs;
  const out: ContextReadResult[] = [];
  for (const slug of slugs) {
    const slugPath = path.join(projectsDir, slug);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(slugPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      const full = path.join(slugPath, ent.name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const ctx = readJsonlContext(full);
      if (ctx) out.push(ctx);
    }
  }
  return out;
}
