import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRICING,
  FALLBACK_RATE,
  resolveRate,
  costForGrain,
  canonicalSettings,
  mergePricing,
  type PricingOverrideRow,
} from "../src/pricing.js";

describe("canonicalSettings", () => {
  it("sorts keys and drops null/undefined for a stable hash", () => {
    expect(canonicalSettings({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalSettings({ a: undefined, b: null, c: "x" })).toBe('{"c":"x"}');
    expect(canonicalSettings({})).toBe("{}");
    expect(canonicalSettings(null)).toBe("{}");
  });
});

describe("resolveRate", () => {
  it("prefix-matches a dated model id to the base default", () => {
    const { rate, known } = resolveRate("claude-opus-4-8-20260115", {}, DEFAULT_PRICING, []);
    expect(known).toBe(true);
    const opus = DEFAULT_PRICING.find((r) => r.model === "claude-opus-4")!;
    expect(rate.input).toBe(opus.input);
    expect(rate.cache_write_1h).toBe(opus.cache_write_1h);
  });

  it("falls back for an unknown model", () => {
    const { rate, known } = resolveRate("totally-unknown-9000", {}, DEFAULT_PRICING, []);
    expect(known).toBe(false);
    expect(rate).toEqual(FALLBACK_RATE);
  });

  it("prefers an account override over the default", () => {
    const ov: PricingOverrideRow[] = [
      { model: "claude-opus-4", settings_match_json: "{}", input: 1, output: 2, cache_write_5m: 3, cache_write_1h: 4, cache_read: 5 },
    ];
    const { rate } = resolveRate("claude-opus-4-8", {}, DEFAULT_PRICING, ov);
    expect(rate.input).toBe(1);
    expect(rate.output).toBe(2);
  });

  it("picks the most-specific settings_match when multiple rows match", () => {
    const { rate } = resolveRate("gpt-5.5", { service_tier: "batch" }, DEFAULT_PRICING, []);
    // batch variant placeholder = input 0.625 vs base 1.25
    expect(rate.input).toBe(0.625);
  });

  it("ignores a settings_match that is not a subset of usage settings", () => {
    const { rate } = resolveRate("gpt-5.5", { service_tier: "standard" }, DEFAULT_PRICING, []);
    // standard != batch → base row
    expect(rate.input).toBe(1.25);
  });

  it("account override variant beats default variant", () => {
    const ov: PricingOverrideRow[] = [
      { model: "gpt-5", settings_match_json: '{"service_tier":"batch"}', input: 0.1, output: 0.2, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 },
    ];
    const { rate } = resolveRate("gpt-5.5", { service_tier: "batch" }, DEFAULT_PRICING, ov);
    expect(rate.input).toBe(0.1);
  });
});

describe("costForGrain", () => {
  it("sums the five token classes × per-1M rate", () => {
    const rate = { input: 15, output: 75, cache_write_5m: 18.75, cache_write_1h: 30, cache_read: 1.5 };
    const cost = costForGrain(
      { tokens_in: 1_000_000, tokens_out: 1_000_000, cache_write_5m: 1_000_000, cache_write_1h: 1_000_000, cache_read: 1_000_000 },
      rate,
    );
    expect(cost).toBeCloseTo(15 + 75 + 18.75 + 30 + 1.5, 6);
  });
});

describe("mergePricing", () => {
  it("flags overridden rows and carries the default_rate", () => {
    const ov: PricingOverrideRow[] = [
      { model: "claude-opus-4", settings_match_json: "{}", input: 99, output: 99, cache_write_5m: 99, cache_write_1h: 99, cache_read: 99 },
    ];
    const merged = mergePricing(DEFAULT_PRICING, ov);
    const opus = merged.find((r) => r.model === "claude-opus-4" && r.settings_match_json === "{}")!;
    expect(opus.overridden).toBe(true);
    expect(opus.input).toBe(99); // effective = override
    expect(opus.default_rate!.input).toBe(15); // original default preserved
    const sonnet = merged.find((r) => r.model === "claude-sonnet-4")!;
    expect(sonnet.overridden).toBe(false);
  });

  it("includes override-only rows that have no matching default", () => {
    const ov: PricingOverrideRow[] = [
      { model: "custom-model", settings_match_json: "{}", input: 1, output: 1, cache_write_5m: 1, cache_write_1h: 1, cache_read: 1 },
    ];
    const merged = mergePricing(DEFAULT_PRICING, ov);
    const custom = merged.find((r) => r.model === "custom-model")!;
    expect(custom).toBeDefined();
    expect(custom.overridden).toBe(true);
    expect(custom.default_rate).toBeNull();
  });
});
