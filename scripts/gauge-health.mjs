#!/usr/bin/env node
// Report profiles whose usage gauge has gone DEAD (no non-NULL reading recently).
//
//   node --experimental-sqlite scripts/gauge-health.mjs            # human-readable
//   node --experimental-sqlite scripts/gauge-health.mjs --json     # machine-readable
//
// Exit 0 = every watched gauge is fresh. Exit 1 = at least one is stale.
// Exit 2 = the check itself could not run (DB missing/locked) — distinct on
// purpose, so a broken checker is never mistaken for a clean bill of health.
//
// WHY THIS EXISTS. The `claude-max` gauge read NULL for NINE DAYS before anyone
// noticed: its profiles.config_dir had drifted to a directory with no usable
// credentials, so every poll "succeeded" at the loop level and wrote a NULL
// five_hour_pct. Nothing watched for that. The in-process `auth_failure` alert
// could not have caught it either — it is delivered as an MCP channel
// notification, and the systemd agent daemon (which does all the polling) has
// no MCP client attached, so its alerts go nowhere. This runs OUT of process,
// straight off the store, and is therefore immune to both failure modes.
//
// SCOPE: only `anthropic-oauth` profiles are watched by default. Other vendors
// legitimately leave five_hour_pct NULL — codex reports a weekly window into
// the seven_day slot, xai-grok likewise, deepseek-balance reports a dollar
// balance and no percentage at all. Alerting on those would be pure noise.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

function optValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const dbPath =
  optValue("--db", process.env.CLAUDE_PULSE_DB) ||
  path.join(os.homedir(), ".claude-pulse", "usage.db");

// Staleness budget = max(multiplier x poll_interval_minutes, floor).
// The floor matters: the systemd agent daemon drives polls off its OWN loop
// cadence (CLAUDE_PULSE_PUSH_USAGE_INTERVAL), not per-profile
// poll_interval_minutes, so a small configured interval must not produce a
// threshold tighter than the real cadence.
const MULTIPLIER = Number(optValue("--multiplier", "3"));
const FLOOR_MINUTES = Number(optValue("--floor-minutes", "90"));
const VENDORS = optValue("--vendors", "anthropic-oauth")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  // The store is written concurrently by the daemon and the upload cron; wait
  // rather than reporting a spurious failure.
  db.exec("PRAGMA busy_timeout=15000");
} catch (err) {
  const msg = `claude-pulse gauge check could not open ${dbPath}: ${err.message}`;
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, findings: [] }));
  else console.error(msg);
  process.exit(2);
}

let rows;
try {
  rows = db
    .prepare(
      `SELECT p.name                          AS profile,
              p.vendor                        AS vendor,
              p.config_dir                    AS config_dir,
              p.poll_interval_minutes         AS poll_interval_minutes,
              (SELECT MAX(polled_at) FROM usage_snapshots s
                 WHERE s.profile = p.name)                             AS last_poll,
              (SELECT MAX(polled_at) FROM usage_snapshots s
                 WHERE s.profile = p.name AND s.five_hour_pct IS NOT NULL) AS last_reading,
              (SELECT COUNT(*) FROM usage_snapshots s
                 WHERE s.profile = p.name
                   AND s.polled_at > datetime('now', '-24 hours'))     AS polls_24h,
              (SELECT COUNT(*) FROM usage_snapshots s
                 WHERE s.profile = p.name
                   AND s.five_hour_pct IS NOT NULL
                   AND s.polled_at > datetime('now', '-24 hours'))     AS readings_24h
         FROM profiles p
        ORDER BY p.name`,
    )
    .all();
} catch (err) {
  const msg = `claude-pulse gauge check failed to query ${dbPath}: ${err.message}`;
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, findings: [] }));
  else console.error(msg);
  process.exit(2);
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

/** SQLite datetime('now') strings are UTC with a space separator. */
function parseUtc(ts) {
  if (!ts) return null;
  const iso = String(ts).includes("T") ? String(ts) : `${String(ts).replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

const now = Date.now();
const findings = [];
const watched = [];

for (const r of rows) {
  if (!VENDORS.includes(r.vendor)) continue;

  const budgetMin = Math.max(MULTIPLIER * (r.poll_interval_minutes || 0), FLOOR_MINUTES);
  const lastReadingMs = parseUtc(r.last_reading);
  const ageMin = lastReadingMs === null ? null : Math.round((now - lastReadingMs) / 60000);

  const entry = {
    profile: r.profile,
    vendor: r.vendor,
    config_dir: r.config_dir,
    poll_interval_minutes: r.poll_interval_minutes,
    budget_minutes: budgetMin,
    last_poll: r.last_poll,
    last_reading: r.last_reading,
    reading_age_minutes: ageMin,
    polls_24h: r.polls_24h,
    readings_24h: r.readings_24h,
    stale: ageMin === null || ageMin > budgetMin,
  };
  watched.push(entry);

  if (!entry.stale) continue;

  // Distinguish the two shapes so the alert is actionable on its own:
  //   polling but never reading  => NULL gauge  => config_dir / credentials
  //   not polling at all         => the poller itself is dead
  entry.diagnosis =
    r.polls_24h > 0
      ? `polled ${r.polls_24h}x in 24h but produced ${r.readings_24h} reading(s) — NULL gauge, ` +
        `suspect config_dir/credentials (is ${r.config_dir} the dir the "${r.profile}" wrapper exports?)`
      : `no polls at all in 24h — suspect the poller/daemon, not the credentials`;
  findings.push(entry);
}

if (asJson) {
  console.log(JSON.stringify({ ok: findings.length === 0, watched, findings }, null, 2));
} else if (findings.length === 0) {
  console.log(
    `claude-pulse: ${watched.length} watched gauge(s) fresh ` +
      `(${watched.map((w) => `${w.profile}=${w.reading_age_minutes}m`).join(", ")})`,
  );
} else {
  for (const f of findings) {
    const age = f.reading_age_minutes === null ? "NEVER" : `${f.reading_age_minutes}m ago`;
    console.log(
      `STALE GAUGE: ${f.profile} — last non-NULL 5h reading ${age} ` +
        `(budget ${f.budget_minutes}m); ${f.diagnosis}`,
    );
  }
}

process.exit(findings.length === 0 ? 0 : 1);
