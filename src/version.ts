import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reporter code-version stamp, e.g. "0.1.0+a1b2c3d" (or "0.1.0" outside a git
 * checkout). Included in every /api/ingest push so the central receiver can
 * record WHICH build produced each snapshot — a reporter running days-old code
 * once silently pushed garbage and identifying the stale process took hours.
 *
 * Resolved at runtime (package.json version + short git SHA when available)
 * and cached for the process lifetime. Returns null when even package.json
 * can't be located — callers treat the stamp as best-effort metadata.
 */

let cached: string | null | undefined;

export function reporterVersion(): string | null {
  if (cached === undefined) cached = computeReporterVersion();
  return cached;
}

/** Test hook: clear the process-lifetime cache. */
export function _resetReporterVersionCache(): void {
  cached = undefined;
}

function computeReporterVersion(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url)); // dist/ (built) or src/ (tsx)
  let version: string | null = null;
  let pkgDir: string | null = null;
  for (const dir of [path.join(moduleDir, ".."), path.join(moduleDir, "..", "..")]) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg?.name === "claude-pulse" && typeof pkg.version === "string") {
        version = pkg.version;
        pkgDir = dir;
        break;
      }
    } catch {
      /* keep looking */
    }
  }
  if (!version || !pkgDir) return null;

  const sha = gitShortSha(pkgDir);
  return sha ? `${version}+${sha}` : version;
}

/** Short git SHA of the checkout containing `dir`, or null (npm installs). */
function gitShortSha(dir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
