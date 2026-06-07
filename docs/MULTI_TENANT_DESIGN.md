# claude-pulse — multi-tenant usage-metering service

Turns claude-pulse from a personal dashboard into a service multiple **accounts** use.
A profile (e.g. `claude-max`) runs on **many machines at once**; data dimensions differ
per metric. Auth/identity comes from oauth2-proxy in front of the dashboard, which
forwards the signed-in user in the `X-Auth-Request-Email` header (already enabled).

## Identity & isolation
- **account** = the authenticated identity (the `X-Auth-Request-Email` value). Auto-create
  an `accounts` row on first authenticated request. Everything is scoped to it.
- Browser/dashboard reads: derive `account` from `X-Auth-Request-Email`. **Every** read
  query MUST filter by `account_id`. No cross-account reads, ever.
- Machine→server pushes (`/api/ingest`): authenticated by a per-(account,machine) **ingest
  token** (see below); the rows are attributed to the *token's* account + machine
  (authoritative — never trust an account/host field in the body).
- Local dev / single-tenant fallback: if no `X-Auth-Request-Email` header is present
  (e.g. hitting the pod directly), use a configurable default account
  (`CLAUDE_PULSE_DEFAULT_ACCOUNT`, default `local`) so direct/in-cluster calls still work.

## Dimensional model (drill-down: account → profile → machine → session → model/settings)
- **settings** = a small JSON of cost-relevant knobs: `{effort, service_tier, ...}` (e.g.
  codex reasoning effort, Anthropic batch/priority tier). Stored + hashed for keying.

### Tables (all `node:sqlite`, add via `initDb` with migration-safe guards)
- `accounts(id pk, identity unique, display_name, created_at)`
- `ingest_tokens(id pk, account_id fk, machine, token_hash unique, created_at, last_used_at, revoked_at)`
  — one per (account, machine). Token shown ONCE at mint; only the hash is stored
  (sha-256). Validate by hashing the presented bearer and looking it up where
  `revoked_at IS NULL`; stamp `last_used_at`.
- `machines(account_id, name, first_seen, last_seen)` — unique (account_id,name); upserted
  from ingest + local.
- **`token_usage`** (fine-grained, the drill-in grain):
  `(id pk, account_id, profile, machine, session_id, model, settings_hash, settings_json,
    day TEXT 'YYYY-MM-DD', tokens_in, tokens_out, cache_write_5m, cache_write_1h,
    cache_read, source 'local'|'ingest', updated_at)`,
  UNIQUE `(account_id, profile, machine, session_id, model, settings_hash, day)`, upsert.
  Default token **rollups aggregate this session-agnostically** up to (account, machine,
  profile[, day]); session/model/settings are only for drill-in.
- **`context_sessions`** (live context per session):
  `(account_id, profile, machine, session_id, model, settings_json, context_tokens,
    context_pct, effective_limit, updated_at, last_active_at)`, unique
  `(account_id, profile, machine, session_id)`, upsert. **Sessions with
  `last_active_at` older than 1 day are excluded from reads and swept periodically.**
- `usage_snapshots` (existing 5h/7d) → add `account_id`. 5h/7d % stays **per profile**
  (account-level window; do NOT subdivide by machine). Keep existing context columns for
  back-compat but the multi-session truth now lives in `context_sessions`.
- `pricing_defaults(model, settings_match_json, input, output, cache_write_5m,
   cache_write_1h, cache_read, source_url, as_of)` — global, seeded from research (USD per
   1e6 tokens). `settings_match_json` lets a row apply to a tier/effort variant; the most
   specific match wins, else the base model row, else a default.
- `pricing_overrides(account_id, model, settings_match_json, input, output, cache_write_5m,
   cache_write_1h, cache_read, updated_at)` — per-account. **Effective rate = override if
   present, else default.** Cost is recomputed from token grains × effective rate, so
   editing rates re-prices history.

## HTTP API (server.ts) — all account-scoped
- `GET /api/me` → `{account, machines:[...]}` (from header).
- `GET /api/usage|/api/pace|/api/context` → scoped to account. `/api/context` returns
  sessions grouped by (profile→machine→session), excluding >1-day-stale.
- `GET /api/reports?granularity=daily|weekly&days=N&drill=account|profile|machine|session|model`
  → token + cost rollups at the requested drill level (default: profile, session-agnostic,
  with by_machine + by_day breakdowns).
- `POST /api/ingest` (bearer ingest-token, **bypasses oauth**, 503 if ingest disabled / 401
  bad token / 413 >1MB): body `{rollups:[token_usage rows...], context:[context_sessions
  rows...]}`. Attribute to the token's (account, machine). Upsert both.
- `GET/POST/DELETE /api/ingest-tokens` (behind oauth) → mint (returns token once, tied to
  `X-Auth-Request-Email`, names a machine) / list (masked) / revoke. Per (account,machine).
- `GET /api/pricing` (defaults merged with this account's overrides) ·
  `PUT /api/pricing` (upsert this account's overrides) · `DELETE /api/pricing/:model` (reset).
- Dashboard HTML: **Token Reports** (per profile → cost + tokens, by-machine breakdown,
  drill-in), **Sessions/Context** (per profile, live sessions grouped by machine),
  **Settings → Machines & Tokens** (mint/revoke), **Settings → Pricing** (editable rate
  table prefilled with defaults). Keep the existing dark theme + mobile layout.

## Client (uploader, index.ts) — `CLAUDE_PULSE_MODE=upload` / `--upload-once`
With `CLAUDE_PULSE_UPLOAD_TO` + `CLAUDE_PULSE_INGEST_TOKEN`: compute last-2-days fine-grained
`token_usage` rows AND current `context_sessions` for all local profiles (tagging
session_id + model + settings + cache-window split), POST to `${UPLOAD_TO}/api/ingest`,
log, exit. No server/pollers in this mode. The central pod also ingests *itself* locally
(it already reads tron's transcripts), so tron needs no uploader.

## Continuous reporting from the long-running daemon (opt-in)
The same two env vars (`CLAUDE_PULSE_UPLOAD_TO` + `CLAUDE_PULSE_INGEST_TOKEN`) ALSO make the
LONG-RUNNING process (normal MCP stdio mode AND `CLAUDE_PULSE_SERVER_ONLY=1`) push to central:
after **each token-rollup pass** and **each context poll**, the daemon writes locally first,
then POSTs the just-computed rollups / current context to `${UPLOAD_TO}/api/ingest`
(`Authorization: Bearer …`, body `{rollups:[…],context:[…]}`). The shared `pushToCentral`
helper (`src/upload.ts`) **chunks the body** so every POST stays under the server's 1MB
`/api/ingest` cap (see below). Push failures only log + back off (exponential, 30s→15m cap) —
they never crash the daemon, and local DB writes are unaffected. When the two env vars are
unset, behavior is unchanged (e.g. the central pod, which ingests its own data locally, sets
neither and so never uploads to itself).

### Body chunking (how batch size is decided)
`chunkUpload` greedily packs rows into chunks bounded by **both**:
- a row-count ceiling (`MAX_ROWS_PER_CHUNK = 500`), and
- a serialized-byte ceiling (`INGEST_SAFE_BYTES = 900KB`, comfortably under the 1MB server cap).

Before adding a row it measures `JSON.stringify({rollups,context})` of the prospective chunk;
if either ceiling would be exceeded it flushes the current chunk and starts a new one. Each
chunk is one POST. Context rows ride along in the same chunks (and a trailing chunk carries
any leftover context).

## Env-var contract (reporting + backfill)
| Env var | Meaning |
|---|---|
| `CLAUDE_PULSE_UPLOAD_TO` | Central claude-pulse base URL (e.g. `https://pulse.example`). Enables uploading. |
| `CLAUDE_PULSE_INGEST_TOKEN` | This machine's bearer token (minted in the dashboard, per (account, machine)). Required alongside `UPLOAD_TO`. |
| `CLAUDE_PULSE_BACKFILL=1` | On startup, run ONE full-history tally for every **local** profile and upsert into the **local** `token_usage` (host=hostname, account=DEFAULT). For the central/tron pod. Idempotent. |
| `CLAUDE_PULSE_UPLOAD_BACKFILL=1` | Full-history tally **pushed to central** in chunks (requires `UPLOAD_TO`+`INGEST_TOKEN`). In one-shot `CLAUDE_PULSE_MODE=upload` it makes the single push full-history then exits; in a long-running mode it backfills once then continues incremental reporting. `--backfill` is the CLI-flag equivalent. |

Both backfills also record/push the current `context_sessions` once. Full-history scans still
stream transcripts line-by-line, so memory stays bounded across thousands of files.

### Quickstart — report a machine to a central server
1. In the dashboard (Settings → Machines & Tokens) **mint an ingest token** for this machine.
2. Set the two env vars on the machine's daemon: `CLAUDE_PULSE_UPLOAD_TO=<central-url>` and
   `CLAUDE_PULSE_INGEST_TOKEN=<minted-token>`.
3. Restart the daemon — it now pushes rollups + context continuously (in addition to its local DB).
4. (Optional, one-time) seed full history: run once with `CLAUDE_PULSE_UPLOAD_BACKFILL=1` (or
   `--backfill`), or `CLAUDE_PULSE_MODE=upload CLAUDE_PULSE_UPLOAD_BACKFILL=1` for a one-shot.

## Push/telemetry architecture (central = pure receiver, every machine = local agent)

The deployment model is: **central server = pure receiver** (Postgres store + HTTP
UI + `/api/ingest`, NO local-file pollers, no config-dir access); **every machine
(incl. tron) = a local agent** that polls locally and PUSHES all signals to the
central server, attributed to its per-(account,machine) ingest token.

### Extended `/api/ingest` body (all sections optional)
```jsonc
{
  "rollups":   [ /* token_usage grain rows (account+machine from token) */ ],
  "context":   [ /* context_sessions rows (account+machine from token) */ ],
  "snapshots": [ /* 5h/7d usage_snapshots — ACCOUNT-LEVEL per profile,
                    latest-poll-wins; machine is metadata only, NOT fanned out */ ],
  "gemini":    [ /* gemini_quota buckets — per-ACCOUNT */ ]
}
```
- `rollups` / `context` — unchanged from before.
- `snapshots[]`: `{profile, five_hour_pct, five_hour_resets_at, seven_day_pct,
  seven_day_resets_at, context_tokens?, context_pct?, context_session_id?,
  context_model?, context_effective_limit?, context_last_reset_at?, polled_at?}`.
  Stored scoped to the **token's account + profile**, latest poll wins (newest
  `polled_at`). The profile row is auto-created for the account if absent (FK).
- `gemini[]`: `{model_id, remaining_fraction, remaining_amount, reset_time}`.
  Stored scoped to the **token's account**; `/api/gemini-quota` reads are
  account-scoped.
- Per-account caps + rate-limit on `/api/ingest` are preserved; snapshots+gemini
  count toward the per-request row cap. Chunking (`pushToCentral`) keeps each POST
  under the 1MB cap; snapshots+gemini ride on the FIRST chunk exactly once.
- Response adds `snapshots_upserted` + `gemini_upserted` counts.

### Migration notes (new account_id columns)
- `usage_snapshots.account_id` already existed (multi-tenant rework). No new
  migration; ingest just scopes inserts to the token's account.
- `gemini_quota.account_id` is **new** (migration-safe `ALTER TABLE ... ADD COLUMN
  IF NOT EXISTS` / SQLite PRAGMA guard). Existing rows are backfilled to the
  default/local account in `createSchema`. A new
  `idx_gemini_quota_account_model_time` index supports per-account reads.

### Env-var contract (receiver-only + agent + gemini)
| Env var | Meaning |
|---|---|
| `CLAUDE_PULSE_RECEIVER_ONLY=1` | With `CLAUDE_PULSE_SERVER_ONLY=1`: pure receiver — starts HTTP server + DB only; runs NO `pollAllProfiles`, gemini poller, context poller, or token-rollup loop. |
| `CLAUDE_PULSE_AGENT=1` (or `CLAUDE_PULSE_MODE=agent` / `--agent`) | Long-lived local collector daemon. Requires `CLAUDE_PULSE_UPLOAD_TO` + `CLAUDE_PULSE_INGEST_TOKEN`. Polls locally + pushes each signal on its own cadence; writes its own local store; fail-soft per signal. |
| `CLAUDE_PULSE_PUSH_CONTEXT_INTERVAL` | Agent: context push interval (ms, default 30000). |
| `CLAUDE_PULSE_PUSH_USAGE_INTERVAL` | Agent: 5h/7d snapshot push interval (ms, default 180000). |
| `CLAUDE_PULSE_PUSH_TOKENS_INTERVAL` | Agent: token-rollup push interval (ms, default 180000; last-2-day window). |
| `CLAUDE_PULSE_PUSH_GEMINI_INTERVAL` | Agent: gemini-quota push interval (ms, default 300000). |
| `CLAUDE_PULSE_GEMINI_CLIENT_SECRET` | Override the gemini-cli public installed-app client secret used in the OAuth refresh (`client_secret`). Defaults to the well-known constant. Config, not a real secret. |
| `CLAUDE_PULSE_DB_PATH` | Override the local SQLite store path (ignored when Postgres env is set). |

The existing one-shot `CLAUDE_PULSE_MODE=upload` + `--backfill` and the continuous
reporting wired into the long-running daemon loops keep working; both now also
push `snapshots` + `gemini` so a machine's first sync is complete.

## Out of scope here / decisions deferred
- **Who may sign up** (open the herodevs realm vs a dedicated public realm vs an allow-list)
  is a deliberate auth-posture decision — the app is built fully multi-tenant + isolated,
  but widening oauth2-proxy beyond Ryan's allow-list is gated on Ryan's go.
- Per-account rate-limiting / abuse controls on `/api/ingest` (size cap is in; add per-token
  throttle later).
