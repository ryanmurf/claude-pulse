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

// ── PLACEHOLDER DEFAULT PRICING ──────────────────────────────────────────────
//
// TODO(ryan): REPLACE THESE NUMBERS WITH RESEARCHED VALUES. Every rate below is
// a PLACEHOLDER carried over from the prior single-tenant MODEL_PRICING table
// (USD per 1e6 tokens). The 5m/1h cache-write split is also a placeholder: most
// public price sheets quote a single "cache write" rate, so 5m == base write and
// 1h == 2x base write here purely as a stand-in until real numbers land.
// The STRUCTURE (keys, settings_match variants, override logic) is what matters;
// the magnitudes are not authoritative.
//
// Keyed by a normalised (lowercased) model id, prefix-matched downstream so a
// dated id like "claude-opus-4-8-20260115" resolves via the "claude-opus-4" key.
export const DEFAULT_PRICING: PricingRow[] = [
  // Anthropic Opus 4.x — $15 / $75, cache write 1.25x input, cache read 0.1x input
  { model: "claude-opus-4", settings_match_json: "{}", input: 15, output: 75, cache_write_5m: 18.75, cache_write_1h: 30, cache_read: 1.5 },
  // Anthropic Sonnet 4.x — $3 / $15
  { model: "claude-sonnet-4", settings_match_json: "{}", input: 3, output: 15, cache_write_5m: 3.75, cache_write_1h: 6, cache_read: 0.3 },
  // Anthropic Haiku 4.x — $1 / $5
  { model: "claude-haiku-4", settings_match_json: "{}", input: 1, output: 5, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1 },
  // DeepSeek chat — cache write priced same as input miss; cache read steeply discounted
  { model: "deepseek", settings_match_json: "{}", input: 0.27, output: 1.1, cache_write_5m: 0.27, cache_write_1h: 0.27, cache_read: 0.07 },
  // OpenAI gpt-5.x family — $1.25 / $10, cached input 0.1x
  { model: "gpt-5", settings_match_json: "{}", input: 1.25, output: 10, cache_write_5m: 1.25, cache_write_1h: 1.25, cache_read: 0.125 },
  // EXAMPLE settings-variant placeholder: a discounted "batch" service tier for gpt-5.
  // Demonstrates the most-specific-match override path; numbers are placeholders.
  { model: "gpt-5", settings_match_json: "{\"service_tier\":\"batch\"}", input: 0.625, output: 5, cache_write_5m: 0.625, cache_write_1h: 0.625, cache_read: 0.0625 },
];

// PLACEHOLDER fallback when a model id matches nothing above (TODO: revisit).
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
