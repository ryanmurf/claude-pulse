import { describe, it, expect } from "vitest";
import { redactProfile } from "../src/redact.js";
import type { Profile } from "../src/types.js";

describe("redactProfile", () => {
  it("redacts api_key when it is set", () => {
    const profile: Profile = {
      name: "test",
      config_dir: "/tmp",
      poll_interval_minutes: 5,
      vendor: "anthropic-oauth",
      monthly_budget_usd: null,
      api_key: "sk-secret-key",
      created_at: "2026-05-03T00:00:00Z",
      updated_at: "2026-05-03T00:00:00Z",
    };
    const redacted = redactProfile(profile);
    expect(redacted.api_key).toBe("***");
  });

  it("leaves api_key as null when it is null", () => {
    const profile: Profile = {
      name: "test",
      config_dir: "/tmp",
      poll_interval_minutes: 5,
      vendor: "anthropic-oauth",
      monthly_budget_usd: null,
      api_key: null,
      created_at: "2026-05-03T00:00:00Z",
      updated_at: "2026-05-03T00:00:00Z",
    };
    const redacted = redactProfile(profile);
    expect(redacted.api_key).toBeNull();
  });
});
