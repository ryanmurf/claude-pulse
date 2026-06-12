import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reporterVersion, _resetReporterVersionCache } from "../src/version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("reporterVersion", () => {
  it("resolves the package.json version (with optional +sha suffix)", () => {
    _resetReporterVersionCache();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ) as { version: string };

    const v = reporterVersion();
    expect(v).not.toBeNull();
    // "0.1.0" or "0.1.0+a1b2c3d" — never anything else.
    expect(v).toMatch(new RegExp(`^${pkg.version.replace(/\./g, "\\.")}(\\+[0-9a-f]{4,40})?$`));
  });

  it("caches the computed value for the process lifetime", () => {
    _resetReporterVersionCache();
    expect(reporterVersion()).toBe(reporterVersion());
  });
});
