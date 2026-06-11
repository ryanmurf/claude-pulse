/**
 * Per-account pricing resolution.
 *
 * Rates are USD per 1e6 (one million) tokens, split across the five billable
 * token classes claude-pulse tracks at the fine grain:
 *   - input        — uncached input tokens
 *   - output       — output tokens
 *   - cache_write_5m — 5-minute-TTL cache-creation tokens
 *   - cache_write_1h — 1-hour-TTL cache-creation tokens
 *   - cache_read   — cache-hit (read) tokens
 *
 * Resolution order for an effective rate:
 *   1. account override whose `settings_match` is the most-specific match
 *   2. account override base row (settings_match = {})
 *   3. global default whose `settings_match` is the most-specific match
 *   4. global default base row
 *   5. hard-coded FALLBACK_RATE
 *
 * "Most specific" = the candidate `settings_match` is a subset of the row's
 * settings AND has the largest number of matched keys. A row with an empty
 * `settings_match` ({}) matches anything (the base row).
 */

export interface PricingRate {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export interface PricingRow extends PricingRate {
  model: string;
  /** JSON-string of cost-relevant knobs this row applies to, e.g. {"service_tier":"batch"}. "" or "{}" = base row. */
  settings_match_json: string;
  source_url?: string | null;
  as_of?: string | null;
}

export interface PricingOverrideRow extends PricingRate {
  model: string;
  settings_match_json: string;
}

// ── DEFAULT PRICING (researched 2026-06-06; Claude 5 Fable/Mythos added 2026-06-11) ──
//
// USD per 1,000,000 tokens. Sources (seen 2026-06-06):
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI     https://developers.openai.com/api/docs/pricing
//   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing
//   Google     https://ai.google.dev/gemini-api/docs/pricing
//
// These are the global defaults; each account can override any row via the
// Pricing settings (pricing_overrides). They are intentionally editable — treat
// them as current-as-of the date above, not eternal truth.
//
// Notes:
//  - Only Anthropic charges a separate cache-WRITE with a 5m/1h TTL split. For
//    every non-Anthropic model cache_write_5m/1h = 0 (no such charge), and
//    cache_read = the provider's discounted cached-input rate.
//  - Reasoning "effort" is NOT a per-token rate lever for any provider — higher
//    effort just emits more output tokens, which we already meter. The only true
//    rate variants are service tiers (batch/flex/priority), Anthropic Fast Mode,
//    and data residency — model those as settings_match variants below.
//  - Keyed by a normalised (lowercased) model id, LONGEST-prefix-matched
//    downstream, so "claude-opus-4-8-20260115" resolves via "claude-opus-4" and
//    "gpt-5.4-mini-…" resolves via "gpt-5.4-mini" (more specific) over "gpt-5.4".
export const DEFAULT_PRICING: PricingRow[] = [
  // Anthropic Claude 5 (Fable/Mythos, released 2026-06-09; seen 2026-06-11 at the
  // Anthropic pricing URL above) — $10/$50, double Opus 4.8. Same cache multipliers
  // (5m=1.25x, 1h=2x, read=0.1x of input). Ids like "claude-fable-5[1m]" and dated
  // ids prefix-match the base key; 1M context is standard pricing (no premium).
  { model: "claude-fable-5", settings_match_json: "{}", input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1 },
  { model: "claude-mythos-5", settings_match_json: "{}", input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1 },
  // Claude 5 batch tier — 50% off input/output (cache rates scale too)
  { model: "claude-fable-5", settings_match_json: "{\"service_tier\":\"batch\"}", input: 5, output: 25, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.5 },

  // Anthropic Claude 4.x (current Opus 4.5–4.8 = $5/$25; cache write 5m=1.25x, 1h=2x, read=0.1x of input)
  { model: "claude-opus-4", settings_match_json: "{}", input: 5, output: 25, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.5 },
  { model: "claude-sonnet-4", settings_match_json: "{}", input: 3, output: 15, cache_write_5m: 3.75, cache_write_1h: 6, cache_read: 0.3 },
  { model: "claude-haiku-4", settings_match_json: "{}", input: 1, output: 5, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1 },
  // Anthropic batch tier — 50% off input/output (cache rates scale too)
  { model: "claude-opus-4", settings_match_json: "{\"service_tier\":\"batch\"}", input: 2.5, output: 12.5, cache_write_5m: 3.125, cache_write_1h: 5, cache_read: 0.25 },

  // OpenAI GPT-5.x (no cache-write charge; cache_read = discounted cached-input)
  { model: "gpt-5.5-pro", settings_match_json: "{}", input: 30, output: 180, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 },
  { model: "gpt-5.5", settings_match_json: "{}", input: 5, output: 30, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.5 },
  { model: "gpt-5.4-nano", settings_match_json: "{}", input: 0.2, output: 1.25, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.02 },
  { model: "gpt-5.4-mini", settings_match_json: "{}", input: 0.75, output: 4.5, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.075 },
  { model: "gpt-5.4", settings_match_json: "{}", input: 2.5, output: 15, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.25 },
  { model: "gpt-5.3-codex", settings_match_json: "{}", input: 1.75, output: 14, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.175 },
  // OpenAI batch/flex tier — ~50% off (example variant; applies to gpt-5.5)
  { model: "gpt-5.5", settings_match_json: "{\"service_tier\":\"batch\"}", input: 2.5, output: 15, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.25 },

  // DeepSeek V4 (official api-docs.deepseek.com/quick_start/pricing, seen 2026-06-07;
  // cache-miss input = input, cache-hit = cache_read, no cache-write charge).
  // Longest-prefix match: "deepseek-v4-pro-…" -> pro, "deepseek-v4-flash-…" -> flash,
  // anything else "deepseek…" -> the generic flash-priced fallback.
  { model: "deepseek-v4-pro", settings_match_json: "{}", input: 0.435, output: 0.87, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.003625 },
  { model: "deepseek-v4-flash", settings_match_json: "{}", input: 0.14, output: 0.28, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.0028 },
  { model: "deepseek", settings_match_json: "{}", input: 0.14, output: 0.28, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.0028 },

  // Google Gemini (≤200k-token rate; doubles >200k — not modeled. No cache-write charge.)
  { model: "gemini-3.1-pro", settings_match_json: "{}", input: 2, output: 12, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.2 },
  { model: "gemini-3.5-flash", settings_match_json: "{}", input: 1.5, output: 9, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.15 },
  { model: "gemini-2.5-pro", settings_match_json: "{}", input: 1.25, output: 10, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.125 },
  { model: "gemini-2.5-flash", settings_match_json: "{}", input: 0.3, output: 2.5, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.03 },
  // gemini-3-flash-* internal codenames (e.g. "gemini-3-flash-a" seen in
  // Antigravity gen_metadata) don't longest-prefix-match "gemini-3.5-flash";
  // give the 3.x flash line its own row so those calls don't fall to FALLBACK.
  { model: "gemini-3-flash", settings_match_json: "{}", input: 1.5, output: 9, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.15 },

  // Antigravity (`agy` CLI). The CLI routes to a backend model (commonly a
  // Gemini variant, sometimes Claude/gpt-oss); we resolve the conversation-level
  // model from gen_metadata when possible, so a real "gemini-*"/"claude-*" id
  // prices via the rows above. When the model can't be resolved we attribute to
  // "antigravity-unknown" — priced at a conservative mid (Gemini-Pro-ish) rate
  // here so unknowns aren't zeroed. rateForModel/resolveRate flag it via the
  // base-row presence; revisit if Antigravity exposes per-call model ids.
  { model: "antigravity-unknown", settings_match_json: "{}", input: 2, output: 12, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0.2 },
];

// Fallback when a model id matches no row above — mid-range Sonnet-like rate, so
// an unknown model is costed conservatively rather than zeroed. rateForModel
// flags these as known:false so the UI can surface "unknown model" pricing.
export const FALLBACK_RATE: PricingRate = {
  input: 3,
  output: 15,
  cache_write_5m: 3.75,
  cache_write_1h: 6,
  cache_read: 0.3,
};

function safeParseSettings(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Canonical JSON string for a settings object (sorted keys) for stable hashing/keying. */
export function canonicalSettings(settings: Record<string, unknown> | null | undefined): string {
  if (!settings) return "{}";
  const keys = Object.keys(settings)
    .filter((k) => settings[k] !== undefined && settings[k] !== null)
    .sort();
  if (keys.length === 0) return "{}";
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = settings[k];
  return JSON.stringify(obj);
}

/** True if `candidate` (the row's settings_match) is a subset of `target` (the usage settings). */
function isSubset(candidate: Record<string, unknown>, target: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(candidate)) {
    if (target[k] !== v) return false;
  }
  return true;
}

function prefixModelMatch(rows: PricingRow[] | PricingOverrideRow[], model: string): (PricingRow | PricingOverrideRow)[] {
  const norm = model.toLowerCase();
  // Exact key match first, else longest matching prefix key.
  const exact = rows.filter((r) => r.model.toLowerCase() === norm);
  if (exact.length) return exact;
  let bestKey = "";
  for (const r of rows) {
    const k = r.model.toLowerCase();
    if (norm.startsWith(k) && k.length > bestKey.length) bestKey = k;
  }
  if (!bestKey) return [];
  return rows.filter((r) => r.model.toLowerCase() === bestKey);
}

/**
 * Pick the most-specific row from a candidate set for the given usage settings.
 * Most specific = subset of usage settings with the most matched keys; the base
 * row ({}) is the least specific. Returns null if no row's settings_match is a
 * subset of the usage settings (shouldn't happen because base {} always matches).
 */
function pickMostSpecific(
  rows: (PricingRow | PricingOverrideRow)[],
  settings: Record<string, unknown>,
): PricingRow | PricingOverrideRow | null {
  let best: PricingRow | PricingOverrideRow | null = null;
  let bestScore = -1;
  for (const r of rows) {
    const match = safeParseSettings(r.settings_match_json);
    if (!isSubset(match, settings)) continue;
    const score = Object.keys(match).length;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Resolve the effective per-1e6-token rate for a (model, settings) pair, given
 * the global defaults and this account's overrides.
 */
export function resolveRate(
  model: string | null | undefined,
  settings: Record<string, unknown> | null | undefined,
  defaults: PricingRow[],
  overrides: PricingOverrideRow[],
): { rate: PricingRate; known: boolean } {
  const s = settings ?? {};
  if (model) {
    // 1+2. account overrides for this model (most-specific match)
    const ovRows = prefixModelMatch(overrides, model);
    const ov = pickMostSpecific(ovRows, s);
    if (ov) return { rate: rateOf(ov), known: true };

    // 3+4. global defaults for this model (most-specific match)
    const defRows = prefixModelMatch(defaults, model);
    const def = pickMostSpecific(defRows, s);
    if (def) return { rate: rateOf(def), known: true };
  }
  // 5. fallback
  return { rate: { ...FALLBACK_RATE }, known: false };
}

function rateOf(r: PricingRate): PricingRate {
  return {
    input: r.input,
    output: r.output,
    cache_write_5m: r.cache_write_5m,
    cache_write_1h: r.cache_write_1h,
    cache_read: r.cache_read,
  };
}

export interface TokenGrain {
  tokens_in: number;
  tokens_out: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

/** Cost (USD) for a token grain under a resolved rate. Rounded to 6 decimals. */
export function costForGrain(g: TokenGrain, rate: PricingRate): number {
  const cost =
    (g.tokens_in / 1_000_000) * rate.input +
    (g.tokens_out / 1_000_000) * rate.output +
    (g.cache_write_5m / 1_000_000) * rate.cache_write_5m +
    (g.cache_write_1h / 1_000_000) * rate.cache_write_1h +
    (g.cache_read / 1_000_000) * rate.cache_read;
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * Merge defaults with account overrides for the /api/pricing response: every
 * (model, settings_match) row from defaults, with `overridden` flag + effective
 * numbers when an override exists, plus override-only rows (a model/variant the
 * account priced that has no default).
 */
export interface MergedPricingRow extends PricingRate {
  model: string;
  settings_match_json: string;
  source_url: string | null;
  as_of: string | null;
  overridden: boolean;
  default_rate: PricingRate | null;
}

export function mergePricing(defaults: PricingRow[], overrides: PricingOverrideRow[]): MergedPricingRow[] {
  const key = (model: string, sm: string) => `${model.toLowerCase()}::${canonicalSettings(safeParseSettings(sm))}`;
  const overrideMap = new Map<string, PricingOverrideRow>();
  for (const o of overrides) overrideMap.set(key(o.model, o.settings_match_json), o);

  const out: MergedPricingRow[] = [];
  const seen = new Set<string>();

  for (const d of defaults) {
    const k = key(d.model, d.settings_match_json);
    seen.add(k);
    const ov = overrideMap.get(k);
    const eff = ov ? rateOf(ov) : rateOf(d);
    out.push({
      model: d.model,
      settings_match_json: canonicalSettings(safeParseSettings(d.settings_match_json)),
      source_url: d.source_url ?? null,
      as_of: d.as_of ?? null,
      overridden: !!ov,
      default_rate: rateOf(d),
      ...eff,
    });
  }

  // Override-only rows (no matching default).
  for (const o of overrides) {
    const k = key(o.model, o.settings_match_json);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      model: o.model,
      settings_match_json: canonicalSettings(safeParseSettings(o.settings_match_json)),
      source_url: null,
      as_of: null,
      overridden: true,
      default_rate: null,
      ...rateOf(o),
    });
  }

  out.sort((a, b) => (a.model === b.model ? a.settings_match_json.localeCompare(b.settings_match_json) : a.model.localeCompare(b.model)));
  return out;
}
