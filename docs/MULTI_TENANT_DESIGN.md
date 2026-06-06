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

## Out of scope here / decisions deferred
- **Who may sign up** (open the herodevs realm vs a dedicated public realm vs an allow-list)
  is a deliberate auth-posture decision — the app is built fully multi-tenant + isolated,
  but widening oauth2-proxy beyond Ryan's allow-list is gated on Ryan's go.
- Per-account rate-limiting / abuse controls on `/api/ingest` (size cap is in; add per-token
  throttle later).
