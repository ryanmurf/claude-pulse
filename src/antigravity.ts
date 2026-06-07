import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

/**
 * Antigravity (`agy` CLI) usage extraction.
 *
 * The Antigravity CLI stores each conversation as a SQLite `.db` under
 * `~/.gemini/antigravity-cli/conversations/<uuid>.db`. The `steps` table has a
 * `step_payload` BLOB column carrying **raw protobuf** (no schema available).
 * Inside, each model-call carries a `usageMetadata` submessage with:
 *   - field  2 = input/prompt tokens (system-prompt-dominated, ~15-19k/call)
 *   - field 10 = output (candidate) tokens
 *   - field  9 = thinking tokens
 *   - field  3 = field9 + field10 (a checksum that identifies a real usage submsg)
 *
 * A conversation has MULTIPLE model-call steps; we sum across them. The same
 * usage object is mirrored in both `steps.metadata` and `steps.step_payload`, so
 * we parse `step_payload` ONLY and dedupe identical {prompt,output,thinking}
 * tuples within a conversation.
 *
 * ⚠️ FRAGILITY: this is an undocumented, reverse-engineered preview-backend
 * protobuf. Field numbers (2/3/9/10 for usage; the model strings in
 * gen_metadata/executor_metadata) were validated empirically and MAY SHIFT in a
 * future Antigravity release. The checksum gate (f3 === f9+f10) is our main
 * guard against mis-identifying a submessage as usage; if Antigravity changes
 * the layout, expect totals to drop to ~0 (we fail closed, not loud) — revisit
 * the field map then.
 */

// ── Minimal raw-protobuf reader ──────────────────────────────────────────────
// Wire types: 0 = varint, 1 = 64-bit, 2 = length-delimited, 5 = 32-bit.

function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let shift = 0n;
  let result = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}

/** Heuristic: a length-delimited field is "text" (vs a nested message) when its
 *  bytes are ≥85% printable. We do NOT recurse into such fields. */
function isPrintable(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let printable = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  }
  return printable / buf.length >= 0.85;
}

type ProtoFields = Record<number, unknown>;

/**
 * Walk a protobuf message. Invokes `visit(fields)` for the top-level message AND
 * (via recursion) for every nested length-delimited message that isn't printable
 * text. `fields` maps fieldNumber → last-seen value (number for varints; {str}
 * for printable; {bytes} for raw; recursion happens before the parent's visit).
 */
function walk(buf: Buffer, visit: (fields: ProtoFields) => void): ProtoFields {
  const fields: ProtoFields = {};
  let pos = 0;
  while (pos < buf.length) {
    let tag: bigint;
    [tag, pos] = readVarint(buf, pos);
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (fieldNo === 0) break; // invalid tag → stop (likely mis-aligned)
    if (wire === 0) {
      let v: bigint;
      [v, pos] = readVarint(buf, pos);
      fields[fieldNo] = Number(v);
    } else if (wire === 1) {
      pos += 8; // 64-bit — not needed for usage/model extraction
    } else if (wire === 2) {
      let len: bigint;
      [len, pos] = readVarint(buf, pos);
      const n = Number(len);
      const sub = buf.subarray(pos, pos + n);
      pos += n;
      if (isPrintable(sub)) {
        fields[fieldNo] = { str: sub.toString("utf8") };
      } else {
        try {
          walk(sub, visit);
        } catch {
          /* ignore malformed nested message */
        }
        fields[fieldNo] = { bytes: sub };
      }
    } else if (wire === 5) {
      pos += 4; // 32-bit — unused
    } else {
      break; // unknown wire type → stop
    }
  }
  visit(fields);
  return fields;
}

// ── Usage extraction ─────────────────────────────────────────────────────────

export interface ConversationUsage {
  prompt: number;
  output: number;
  thinking: number;
}

/** True if a finished submessage looks like a real `usageMetadata`. */
function isUsageMetadata(f: ProtoFields): boolean {
  const f2 = f[2];
  const f9 = f[9];
  const f10 = f[10];
  if (typeof f2 !== "number" || f2 < 50 || f2 >= 2_000_000) return false;
  if (typeof f10 !== "number" && typeof f9 !== "number") return false;
  return true;
}

/**
 * Extract + sum usage across all `step_payload` blobs of a conversation,
 * deduping identical {prompt,output,thinking} tuples (the usage object is
 * mirrored across steps). Returns null if no usage was found.
 *
 * @param payloads raw `steps.step_payload` blobs (parse these only — NOT metadata)
 */
export function extractUsageFromPayloads(payloads: Buffer[]): ConversationUsage | null {
  const seen = new Set<string>();
  let prompt = 0;
  let output = 0;
  let thinking = 0;
  let found = false;
  for (const buf of payloads) {
    walk(buf, (f) => {
      if (!isUsageMetadata(f)) return;
      const p = f[2] as number;
      const t = typeof f[9] === "number" ? (f[9] as number) : 0;
      const o = typeof f[10] === "number" ? (f[10] as number) : 0;
      // Prefer the f3 checksum (f3 === thinking + output) to confirm a real
      // usage submessage; tolerate its absence rather than dropping the row.
      const f3 = f[3];
      if (typeof f3 === "number" && f3 !== t + o) return;
      const key = `${p}|${o}|${t}`;
      if (seen.has(key)) return;
      seen.add(key);
      prompt += p;
      output += o;
      thinking += t;
      found = true;
    });
  }
  if (!found) return null;
  return { prompt, output, thinking };
}

// ── Model extraction (conversation-level) ────────────────────────────────────
//
// The per-CALL model name is NOT co-located with the usage in step_payload — it
// lives in the `gen_metadata` / `executor_metadata` blobs (validated: model
// strings appear nested at varying field paths, e.g. gen_metadata `.1.19`,
// `.3.28`; executor_metadata `.10.1.28`). The paths differ between conversations
// and the model isn't reliably attributable to an individual model-call step, so
// we resolve a single CONVERSATION-LEVEL model: scan those blobs for model-id
// strings and take the most frequent. If none is found we fall back to
// "antigravity-unknown" (priced conservatively in the pricing table).

const ANTIGRAVITY_UNKNOWN_MODEL = "antigravity-unknown";

// A model id looks like "gemini-3.5-flash-low", "claude-opus-4-6", "gpt-oss-…".
// NOTE 1: we search for the id as a SUBSTRING (not anchored): a length-delimited
// protobuf field can carry a few non-printable framing bytes (tag/length) that
// still land ≥85% printable, so the collected "string" may be
// "\xe2\x01\x14gemini-3.5-flash-low". The leading boundary keeps us from
// matching a model word glued onto a longer identifier.
// NOTE 2: we REQUIRE a "-" or "." version/variant separator after the family
// name (e.g. "gemini-…", "claude-…", "gpt-oss"). This rejects bare config-flag
// strings like "used_claude" / "used_claude_conservative" that would otherwise
// poison the resolver (the underscore separates, so the captured token is just
// "claude" with no following "-"/"." — correctly skipped).
const MODEL_ID_RE =
  /(?:^|[^a-z0-9_])((?:gemini|claude|gpt|grok|llama|deepseek|gemma|mistral|qwen|o\d)[.\-][a-z0-9.\-]*)/gi;

/** Recursively collect every printable string in a protobuf blob. */
function collectStrings(buf: Buffer, out: string[]): void {
  let pos = 0;
  while (pos < buf.length) {
    let tag: bigint;
    [tag, pos] = readVarint(buf, pos);
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (fieldNo === 0) break;
    if (wire === 0) {
      [, pos] = readVarint(buf, pos);
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 2) {
      let len: bigint;
      [len, pos] = readVarint(buf, pos);
      const n = Number(len);
      const sub = buf.subarray(pos, pos + n);
      pos += n;
      if (isPrintable(sub)) {
        out.push(sub.toString("utf8"));
      } else {
        try {
          collectStrings(sub, out);
        } catch {
          /* ignore */
        }
      }
    } else if (wire === 5) {
      pos += 4;
    } else {
      break;
    }
  }
}

/**
 * Resolve the conversation-level model id from gen_metadata / executor_metadata
 * blobs. Picks the most-frequently-seen model-id string; ties broken by first
 * seen. Returns "antigravity-unknown" if nothing matches.
 */
export function resolveConversationModel(metadataBlobs: Buffer[]): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const buf of metadataBlobs) {
    const strings: string[] = [];
    try {
      collectStrings(buf, strings);
    } catch {
      /* ignore */
    }
    for (const s of strings) {
      if (s.length > 80) continue;
      MODEL_ID_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MODEL_ID_RE.exec(s)) !== null) {
        // Trim a trailing punctuation char a greedy match may grab.
        const id = m[1].toLowerCase().replace(/[.\-]+$/, "");
        if (id.length < 4 || id.length > 40) continue;
        if (!counts.has(id)) order.push(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) return ANTIGRAVITY_UNKNOWN_MODEL;
  let best = order[0];
  let bestN = counts.get(best) ?? 0;
  for (const id of order) {
    const n = counts.get(id) ?? 0;
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

// ── Timestamp extraction ─────────────────────────────────────────────────────
//
// `steps.step_payload` carries a unix-seconds timestamp in field 1 (~1.78e9,
// validated). We collect the max plausible unix-seconds varint across the
// conversation's payloads to derive the activity day; callers fall back to the
// .db file mtime when none is found.

const MIN_UNIX_S = 1_600_000_000; // ~2020-09
const MAX_UNIX_S = 2_500_000_000; // ~2049

/** Collect plausible unix-seconds varints (any field) from a blob. */
function collectTimestamps(buf: Buffer, out: number[]): void {
  let pos = 0;
  while (pos < buf.length) {
    let tag: bigint;
    [tag, pos] = readVarint(buf, pos);
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (fieldNo === 0) break;
    if (wire === 0) {
      let v: bigint;
      [v, pos] = readVarint(buf, pos);
      const n = Number(v);
      if (n >= MIN_UNIX_S && n <= MAX_UNIX_S) out.push(n);
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 2) {
      let len: bigint;
      [len, pos] = readVarint(buf, pos);
      const n = Number(len);
      const sub = buf.subarray(pos, pos + n);
      pos += n;
      if (!isPrintable(sub)) {
        try {
          collectTimestamps(sub, out);
        } catch {
          /* ignore */
        }
      }
    } else if (wire === 5) {
      pos += 4;
    } else {
      break;
    }
  }
}

/** Latest unix-seconds timestamp found across payloads, or null. */
export function extractLatestTimestamp(payloads: Buffer[]): number | null {
  let max: number | null = null;
  for (const buf of payloads) {
    const ts: number[] = [];
    try {
      collectTimestamps(buf, ts);
    } catch {
      /* ignore */
    }
    for (const t of ts) if (max === null || t > max) max = t;
  }
  return max;
}

// ── Conversation-level tally ─────────────────────────────────────────────────

export interface AntigravityConversation {
  /** Conversation uuid (the .db filename without extension). */
  sessionId: string;
  model: string;
  usage: ConversationUsage;
  /** Activity day YYYY-MM-DD (UTC), derived from a step timestamp or .db mtime. */
  day: string;
}

function utcDayFromUnixSeconds(s: number): string {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

function utcDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Read one Antigravity conversation `.db` and return its summed usage, resolved
 * model, and activity day. Returns null if the db has no usable usage.
 *
 * `mtimeMs` is the file mtime used as the day fallback when no step timestamp is
 * present.
 */
export function tallyConversationDb(dbPath: string, mtimeMs: number): AntigravityConversation | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const payloadRows = db
      .prepare("SELECT step_payload AS b FROM steps WHERE step_payload IS NOT NULL")
      .all() as Array<{ b: unknown }>;
    const payloads = payloadRows
      .map((r) => (Buffer.isBuffer(r.b) ? r.b : r.b == null ? null : Buffer.from(r.b as Uint8Array)))
      .filter((b): b is Buffer => b !== null);

    const usage = extractUsageFromPayloads(payloads);
    if (!usage) return null;

    // Model from gen_metadata + executor_metadata blobs (best-effort).
    const metaBlobs: Buffer[] = [];
    for (const tbl of ["gen_metadata", "executor_metadata"]) {
      try {
        const rows = db.prepare(`SELECT data AS b FROM ${tbl} WHERE data IS NOT NULL`).all() as Array<{ b: unknown }>;
        for (const r of rows) {
          if (Buffer.isBuffer(r.b)) metaBlobs.push(r.b);
          else if (r.b != null) metaBlobs.push(Buffer.from(r.b as Uint8Array));
        }
      } catch {
        /* table may not exist in some db versions */
      }
    }
    const model = resolveConversationModel(metaBlobs);

    const tsSeconds = extractLatestTimestamp(payloads);
    const day = tsSeconds !== null ? utcDayFromUnixSeconds(tsSeconds) : utcDayFromMs(mtimeMs);

    const sessionId = path.basename(dbPath, ".db");
    return { sessionId, model, usage, day };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

// ── Conversation file discovery ──────────────────────────────────────────────

function expandHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

/**
 * List Antigravity conversation `.db` files under a config dir, optionally
 * filtered by mtime window. `configDir` is the antigravity-cli dir (we look in
 * its `conversations/` subdir). Returns [{ path, mtimeMs }].
 */
export function collectConversationDbs(
  configDir: string,
  sinceMs: number | null,
): Array<{ path: string; mtimeMs: number }> {
  const dir = path.join(expandHome(configDir), "conversations");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".db")) continue;
    const full = path.join(dir, ent.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (sinceMs !== null && mtimeMs < sinceMs) continue;
    out.push({ path: full, mtimeMs });
  }
  return out;
}
