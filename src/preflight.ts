import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Profile } from "./types.js";
import { listProfiles, updateProfileConfigDir } from "./store.js";
import { inspectCredentialState, type CredentialInspection } from "./auth.js";

// ── Startup preflight: prove every profile can actually authenticate ─────────
//
// THE FAILURE THIS PREVENTS. `profiles.config_dir` is the only link between a
// gauge and the credentials that feed it, and nothing validated it. When the
// `claude-max` row drifted to `~/.claude` (while the `claude-max` wrapper
// exports `CLAUDE_CONFIG_DIR=~/.claude-max`) the poller kept running happily,
// wrote a NULL five_hour_pct every cycle for NINE DAYS, and the only evidence
// was one "No OAuth tokens found for …" line per poll in a log nobody reads.
//
// Two things make that impossible to repeat:
//   1. A LOUD, structured startup summary — one line per profile naming the
//      resolved config_dir and its credential state, plus an explicit WARN
//      block for anything unusable. A broken profile now announces itself on
//      every daemon start instead of hiding in the noise.
//   2. A NARROW self-heal — if an anthropic-oauth profile's config_dir has no
//      usable credentials but the dir its own launcher wrapper points at does,
//      the row is corrected in place.
//
// Note that fixing the code-level default in `ensureDefaultProfiles` would NOT
// have helped: that insert is `ON CONFLICT DO NOTHING`, so an already-drifted
// row is never touched by it. Repair has to be an explicit UPDATE.

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

/** Vendors whose usage poll authenticates out of `config_dir`'s credential store. */
function usesConfigDirCredentials(vendor: Profile["vendor"]): boolean {
  return vendor === "anthropic-oauth";
}

export interface ProfilePreflight {
  profile: string;
  vendor: Profile["vendor"];
  config_dir: string;
  /** Credential state, or null for vendors that don't authenticate via config_dir. */
  credentials: CredentialInspection | null;
  /** Set when this run repointed the profile; carries the dir it moved away from. */
  healed_from?: string;
  /** True when the profile is expected to produce a usable gauge. */
  healthy: boolean;
}

/**
 * Expand `$HOME` / `${HOME}` / leading `~` and strip surrounding quotes from a
 * value scraped out of a shell wrapper.
 */
function expandShellPath(raw: string): string | null {
  let v = raw.trim().replace(/^["']|["']$/g, "");
  if (!v) return null;
  const home = os.homedir();
  v = v.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
  // Anything still containing shell expansion is not something we can trust.
  if (v.includes("$")) return null;
  return path.resolve(v);
}

/**
 * Read the `CLAUDE_CONFIG_DIR` a launcher wrapper exports.
 *
 * The wrapper is the operator-facing source of truth for which config dir a
 * profile means — `~/.local/bin/claude-max` exporting
 * `CLAUDE_CONFIG_DIR="$HOME/.claude-max"` is precisely what the drifted DB row
 * disagreed with. Best-effort: any parse failure just yields null and the
 * caller falls back to the naming convention.
 */
export async function configDirFromWrapper(
  profileName: string,
  searchDirs: string[] = [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin"],
): Promise<string | null> {
  for (const dir of searchDirs) {
    let text: string;
    try {
      text = await readFile(path.join(dir, profileName), "utf-8");
    } catch {
      continue;
    }
    // Last assignment wins, mirroring shell semantics.
    let found: string | null = null;
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?CLAUDE_CONFIG_DIR=(.+?)\s*$/.exec(line);
      if (m) {
        const expanded = expandShellPath(m[1]);
        if (expanded) found = expanded;
      }
    }
    if (found) return found;
  }
  return null;
}

/**
 * Candidate config dirs for a profile, most-authoritative first: what its
 * launcher wrapper exports, then the `~/.<profile-name>` naming convention that
 * every wrapper follows.
 */
async function candidateConfigDirs(profileName: string): Promise<string[]> {
  const out: string[] = [];
  const fromWrapper = await configDirFromWrapper(profileName);
  if (fromWrapper) out.push(fromWrapper);
  const byConvention = path.join(os.homedir(), `.${profileName}`);
  if (!out.includes(byConvention)) out.push(byConvention);
  return out;
}

/**
 * Inspect every profile, optionally repairing config_dir drift, and log a
 * summary. Never throws: a preflight problem must not stop the daemon from
 * starting and polling the profiles that DO work.
 *
 * Self-heal is deliberately narrow. A profile is repointed only when ALL hold:
 *   - its vendor authenticates out of config_dir (anthropic-oauth), and
 *   - its CURRENT config_dir has no usable credentials (a working dir is never
 *     touched, so an intentional operator choice that works is never clobbered), and
 *   - a candidate dir DOES have usable credentials, and
 *   - no other profile already claims that candidate (never collapse two
 *     profiles onto one identity — that would silently merge two quotas).
 * Set `CLAUDE_PULSE_NO_CONFIG_DIR_HEAL=1` to report drift without correcting it.
 */
export async function runProfilePreflight(opts?: { heal?: boolean }): Promise<ProfilePreflight[]> {
  const healEnabled =
    opts?.heal ?? process.env.CLAUDE_PULSE_NO_CONFIG_DIR_HEAL !== "1";
  let profiles: Profile[];
  try {
    profiles = await listProfiles();
  } catch (e) {
    log(`Preflight: could not list profiles: ${(e as Error).message}`);
    return [];
  }

  const claimed = new Set(profiles.map((p) => path.resolve(p.config_dir)));
  const results: ProfilePreflight[] = [];

  for (const p of profiles) {
    try {
      if (!usesConfigDirCredentials(p.vendor)) {
        results.push({
          profile: p.name,
          vendor: p.vendor,
          config_dir: p.config_dir,
          credentials: null,
          healthy: true,
        });
        continue;
      }

      let configDir = p.config_dir;
      let creds = await inspectCredentialState(configDir);
      let healedFrom: string | undefined;

      if (!creds.usable) {
        for (const candidate of await candidateConfigDirs(p.name)) {
          if (path.resolve(candidate) === path.resolve(configDir)) continue;
          if (claimed.has(path.resolve(candidate))) continue;
          const probe = await inspectCredentialState(candidate);
          if (!probe.usable) continue;

          log(
            `Preflight: CONFIG_DIR DRIFT on profile "${p.name}" — ` +
              `configured dir ${configDir} is unusable (${creds.state}: ${creds.detail}) ` +
              `but ${candidate} has valid credentials (${probe.state}).`,
          );
          if (!healEnabled) {
            log(
              `Preflight: auto-heal disabled (CLAUDE_PULSE_NO_CONFIG_DIR_HEAL=1) — ` +
                `profile "${p.name}" will keep polling ${configDir} and reporting a NULL gauge. ` +
                `Fix with: UPDATE profiles SET config_dir='${candidate}' WHERE name='${p.name}';`,
            );
            break;
          }
          const changed = await updateProfileConfigDir(p.name, candidate);
          if (changed) {
            claimed.delete(path.resolve(configDir));
            claimed.add(path.resolve(candidate));
            healedFrom = configDir;
            configDir = candidate;
            creds = probe;
            log(`Preflight: repointed profile "${p.name}" ${healedFrom} -> ${candidate}`);
          }
          break;
        }
      }

      const entry: ProfilePreflight = {
        profile: p.name,
        vendor: p.vendor,
        config_dir: configDir,
        credentials: creds,
        healthy: creds.usable,
      };
      if (healedFrom) entry.healed_from = healedFrom;
      results.push(entry);
    } catch (e) {
      log(`Preflight: check failed for profile "${p.name}": ${(e as Error).message}`);
      results.push({
        profile: p.name,
        vendor: p.vendor,
        config_dir: p.config_dir,
        credentials: null,
        healthy: false,
      });
    }
  }

  logPreflightSummary(results);
  return results;
}

/**
 * Emit the startup summary: one line per profile, then a loud block for any
 * profile that cannot authenticate. The whole point is that an operator
 * skimming the log sees a broken gauge immediately instead of nine days later.
 */
export function logPreflightSummary(results: ProfilePreflight[]): void {
  log(`Preflight: ${results.length} profile(s)`);
  for (const r of results) {
    const cred = r.credentials
      ? `credentials=${r.credentials.state}`
      : "credentials=n/a (vendor does not authenticate via config_dir)";
    const healed = r.healed_from ? ` (REPOINTED from ${r.healed_from})` : "";
    log(`Preflight:   ${r.profile} [${r.vendor}] config_dir=${r.config_dir} ${cred}${healed}`);
  }

  const broken = results.filter((r) => !r.healthy);
  if (broken.length === 0) return;

  log(
    `Preflight: WARNING — ${broken.length} profile(s) CANNOT authenticate and will record a NULL gauge on every poll:`,
  );
  for (const r of broken) {
    const why = r.credentials ? `${r.credentials.state}: ${r.credentials.detail}` : "inspection failed";
    log(`Preflight: WARNING   profile "${r.profile}" config_dir=${r.config_dir} — ${why}`);
  }
  log(
    `Preflight: WARNING   a NULL gauge is NOT the same as a frozen one. NULL means the poll never ` +
      `authenticated (wrong config_dir, or a credentials file with no usable token); FROZEN means the ` +
      `poll succeeded but the value stopped moving (an OAuth-refresh problem).`,
  );
}
