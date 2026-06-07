import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listProfiles,
  redactProfile,
  getLatestSnapshot,
  getLatestSnapshots,
  getHistory,
  getTriggeredAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  listAlertSubscriptions,
  createAlertSubscription,
  removeAlertSubscription,
  getProfile,
  getLatestGeminiQuota,
  resolveAccount,
  listMachines,
  mintIngestToken,
  listIngestTokens,
  revokeIngestToken,
  validateIngestToken,
  upsertTokenUsage,
  upsertContextSession,
  upsertMachine,
  getActiveContextSessions,
  getFineTokenReport,
  getPricingDefaults,
  getPricingOverrides,
  upsertPricingOverride,
  deletePricingOverride,
} from "./store.js";
import { pollProfile, pollAllProfiles } from "./poller.js";
import { formatGeminiQuotaSnapshots, pollGeminiQuota } from "./gemini.js";
import { mergePricing, canonicalSettings, type PricingOverrideRow } from "./pricing.js";
import type { Account, AlertType, ReportDrill, TokenUsageInput, ContextSessionInput } from "./types.js";

let httpServer: http.Server | undefined;

const DEFAULT_PORT = 7778;

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Default cap on browser-route request bodies (256KB). /api/ingest overrides. */
const DEFAULT_MAX_BYTES = 256 * 1024;

function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    const onData = (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        // Stop buffering and drain the rest of the request so the handler can
        // still send a clean 413 response (destroying the socket here would
        // surface as a connection reset to the client instead).
        req.removeListener("data", onData);
        req.resume();
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks).toString()); });
    req.on("error", reject);
  });
}

const INGEST_MAX_BYTES = 1024 * 1024; // 1MB cap on /api/ingest bodies

/**
 * HTML-escape a value before interpolating into innerHTML. Defense-in-depth
 * against stored XSS: ingest/user-controlled strings (profile, session_id,
 * model, machine names, alert messages) get escaped at render time.
 */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Thrown by accountForRequest when the trust boundary rejects a browser request. */
class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── /api/ingest rate limiting (M1) ──────────────────────────────────────────
// Dependency-free token bucket, per-token AND per-IP, ~60 req/min each.
const INGEST_RATE_CAPACITY = 60; // burst + sustained ceiling per window
const INGEST_RATE_REFILL_PER_MS = 60 / 60_000; // 60 tokens per 60s
interface Bucket { tokens: number; last: number; }
const ingestBuckets = new Map<string, Bucket>();

/** Returns true if the call is allowed; false → 429. Keyed independently. */
function rateLimitAllow(key: string): boolean {
  const now = Date.now();
  let b = ingestBuckets.get(key);
  if (!b) {
    b = { tokens: INGEST_RATE_CAPACITY, last: now };
    ingestBuckets.set(key, b);
  }
  // Refill based on elapsed time.
  b.tokens = Math.min(
    INGEST_RATE_CAPACITY,
    b.tokens + (now - b.last) * INGEST_RATE_REFILL_PER_MS,
  );
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Test/maintenance hook: clear all rate-limit buckets. */
export function _resetIngestRateLimit(): void {
  ingestBuckets.clear();
}

function toFiniteInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function toFiniteNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeParseJson(s: string | null | undefined): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    // The dashboard markup ships inline and changes with every deploy; without
    // this browsers cache the old page and miss new sections (e.g. Settings).
    "Cache-Control": "no-cache, must-revalidate",
  });
  res.end(html);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, { error: message }, status);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Resolve the account for a browser/dashboard request (H4 — header trust boundary).
 *
 * Trust model:
 * - `CLAUDE_PULSE_TRUSTED_PROXY_SECRET` set → the request MUST carry
 *   `X-Pulse-Proxy-Auth` equal to that secret (injected only by our
 *   ingress/oauth2-proxy, never a browser). Missing/wrong → 401. Only then is
 *   the proxy-supplied `X-Auth-Request-Email` honored.
 * - The silent default/`local` account fallback (no authenticated email) is
 *   gated behind `CLAUDE_PULSE_SINGLE_TENANT=1`. When that is NOT set and there
 *   is no authenticated email, browser routes 401 instead of serving `local`.
 * - When neither env is set (dev), behavior is unchanged: header honored if
 *   present, else the default account.
 *
 * A client-supplied email is NEVER honored except on the proxy-validated path.
 */
function accountForRequest(req: IncomingMessage): Account {
  const proxySecret = process.env.CLAUDE_PULSE_TRUSTED_PROXY_SECRET;
  const singleTenant = process.env.CLAUDE_PULSE_SINGLE_TENANT === "1";

  if (proxySecret) {
    // The proxy gate is mandatory: only requests carrying the shared secret
    // (i.e. routed through our ingress) may assert an identity at all.
    const presented = header(req, "x-pulse-proxy-auth");
    if (presented !== proxySecret) {
      throw new AuthError(401, "Unauthorized");
    }
    const email = header(req, "x-auth-request-email");
    if (email) return resolveAccount(email);
    // Proxy authenticated the request but supplied no email.
    if (singleTenant) return resolveAccount(null);
    throw new AuthError(401, "Unauthorized");
  }

  // No proxy secret configured.
  const email = header(req, "x-auth-request-email");
  if (email) return resolveAccount(email);
  if (singleTenant) return resolveAccount(null);
  // Dev convenience (no proxy secret, single-tenant not explicitly disabled):
  // fall back to the default account so direct/in-cluster calls still work.
  // Production hardening sets CLAUDE_PULSE_TRUSTED_PROXY_SECRET to disable this.
  return resolveAccount(null);
}

// ── Pace computation (shared with get_pace tool) ─────────────────────────────

interface PaceInfo {
  profile: string;
  window: string;
  used_pct: number;
  remaining: string;
  elapsed_pct: number;
  pace: string;
}

const WINDOW_DURATIONS: Record<string, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
};

function formatRemaining(ms: number): string {
  if (ms <= 0) return "resetting now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h ${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d ${rh}h` : `${days}d`;
}

function computePace(accountId: number, profileFilter?: string): PaceInfo[] {
  const results: PaceInfo[] = [];
  const names = profileFilter
    ? [profileFilter]
    : listProfiles(accountId).map((p) => p.name);

  for (const name of names) {
    const snap = getLatestSnapshot(name, accountId);
    if (!snap) continue;

    const windows = [
      { key: "five_hour", label: "5h", pct: snap.five_hour_pct, resets: snap.five_hour_resets_at },
      { key: "seven_day", label: "7d", pct: snap.seven_day_pct, resets: snap.seven_day_resets_at },
    ];

    for (const w of windows) {
      if (w.pct === null || !w.resets) continue;
      const duration = WINDOW_DURATIONS[w.key];
      if (!duration) continue;

      const now = Date.now();
      const resetMs = new Date(w.resets).getTime();
      const remaining = resetMs - now;
      const elapsed = duration - remaining;
      const elapsedPct = Math.max((elapsed / duration) * 100, 1);
      const ratio = w.pct / elapsedPct;

      let pace: string;
      if (ratio > 1.5 && w.pct > 50) pace = "conserve";
      else if (ratio < 0.5 && remaining < 3_600_000) pace = "capacity available";
      else if (ratio > 1.2) pace = "slightly fast";
      else pace = "on track";

      results.push({
        profile: name,
        window: w.label,
        used_pct: w.pct,
        remaining: formatRemaining(remaining),
        elapsed_pct: Math.round(elapsedPct * 10) / 10,
        pace,
      });
    }
  }
  return results;
}

// ── Request router ───────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  try {
    // Health probe — unauthenticated, exempt from the proxy-secret/account gate
    // so k8s liveness/readiness work even when CLAUDE_PULSE_TRUSTED_PROXY_SECRET
    // is set (which makes the account-scoped routes 401 without the proxy header).
    if (pathname === "/healthz" && method === "GET") {
      sendJson(res, { ok: true });
      return;
    }

    // Dashboard
    if (pathname === "/" && method === "GET") {
      sendHtml(res, DASHBOARD_HTML);
      return;
    }

    // GET /api/profiles — only the requesting account's profiles (H2/L4)
    if (pathname === "/api/profiles" && method === "GET") {
      const account = accountForRequest(req);
      sendJson(res, listProfiles(account.id).map(redactProfile));
      return;
    }

    // GET /api/me — account identity + this account's machines
    if (pathname === "/api/me" && method === "GET") {
      const account = accountForRequest(req);
      sendJson(res, {
        account: account.identity,
        display_name: account.display_name,
        machines: listMachines(account.id),
      });
      return;
    }

    // GET /api/usage — account-scoped 5h/7d per profile
    if (pathname === "/api/usage" && method === "GET") {
      const account = accountForRequest(req);
      const snapshots = getLatestSnapshots(account.id);
      const profiles = listProfiles(account.id);
      const result = profiles.map((p) => {
        const snap = snapshots.find((s) => s.profile === p.name);
        return {
          profile: p.name,
          five_hour_pct: snap?.five_hour_pct ?? null,
          five_hour_resets_at: snap?.five_hour_resets_at ?? null,
          seven_day_pct: snap?.seven_day_pct ?? null,
          seven_day_resets_at: snap?.seven_day_resets_at ?? null,
          polled_at: snap?.polled_at ?? null,
        };
      });
      sendJson(res, result);
      return;
    }

    // GET /api/gemini-quota
    if (pathname === "/api/gemini-quota" && method === "GET") {
      sendJson(res, formatGeminiQuotaSnapshots(getLatestGeminiQuota()));
      return;
    }

    // GET /api/history?profile=X&hours=24
    if (pathname === "/api/history" && method === "GET") {
      const account = accountForRequest(req);
      const profile = url.searchParams.get("profile");
      if (!profile) { sendError(res, 400, "Missing profile parameter"); return; }
      const hours = parseInt(url.searchParams.get("hours") || "24", 10);
      const limit = parseInt(url.searchParams.get("limit") || "100", 10);
      sendJson(res, getHistory(profile, hours, limit, account.id));
      return;
    }

    // GET /api/pace
    if (pathname === "/api/pace" && method === "GET") {
      const account = accountForRequest(req);
      const profile = url.searchParams.get("profile") || undefined;
      sendJson(res, computePace(account.id, profile));
      return;
    }

    // GET /api/context — live multi-machine context sessions grouped
    // profile → machine → session, excluding >1-day-stale.
    if (pathname === "/api/context" && method === "GET") {
      const account = accountForRequest(req);
      const sessions = getActiveContextSessions(account.id);
      // Group profile → machine → session[]
      const byProfile = new Map<string, Map<string, unknown[]>>();
      for (const s of sessions) {
        let machines = byProfile.get(s.profile);
        if (!machines) { machines = new Map(); byProfile.set(s.profile, machines); }
        let list = machines.get(s.machine);
        if (!list) { list = []; machines.set(s.machine, list); }
        (list as unknown[]).push({
          session_id: s.session_id,
          model: s.model,
          settings: safeParseJson(s.settings_json),
          context_tokens: s.context_tokens,
          context_pct: s.context_pct,
          effective_context: s.effective_limit,
          last_active_at: s.last_active_at,
          updated_at: s.updated_at,
        });
      }
      const result = [...byProfile.entries()].map(([profile, machines]) => ({
        profile,
        machines: [...machines.entries()].map(([machine, list]) => ({ machine, sessions: list })),
      }));
      sendJson(res, result);
      return;
    }

    // GET /api/alerts — scoped to the requesting account (H1/H3)
    if (pathname === "/api/alerts" && method === "GET") {
      const account = accountForRequest(req);
      const profile = url.searchParams.get("profile") || undefined;
      const hours = parseInt(url.searchParams.get("hours") || "24", 10);
      const unacked = url.searchParams.get("unacknowledged_only") === "true";
      sendJson(res, getTriggeredAlerts(account.id, profile, hours, unacked));
      return;
    }

    // POST /api/alerts/acknowledge — by-id path verifies account ownership (IDOR fix)
    if (pathname === "/api/alerts/acknowledge" && method === "POST") {
      const account = accountForRequest(req);
      const body = JSON.parse(await readBody(req));
      if (body.id !== undefined) {
        const ok = acknowledgeAlert(account.id, body.id);
        if (!ok) { sendError(res, 404, "Alert not found"); return; }
        sendJson(res, { success: true });
      } else {
        const count = acknowledgeAllAlerts(account.id, body.profile || undefined);
        sendJson(res, { success: true, count });
      }
      return;
    }

    // GET /api/subscriptions — scoped to the requesting account (H1/H3)
    if (pathname === "/api/subscriptions" && method === "GET") {
      const account = accountForRequest(req);
      const profile = url.searchParams.get("profile") || undefined;
      sendJson(res, listAlertSubscriptions(account.id, profile));
      return;
    }

    // POST /api/subscriptions
    if (pathname === "/api/subscriptions" && method === "POST") {
      const account = accountForRequest(req);
      const body = JSON.parse(await readBody(req));
      if (!body.profile || !body.alert_type) {
        sendError(res, 400, "Missing profile or alert_type");
        return;
      }
      // Profile lookup is scoped to the caller's account — can't subscribe to
      // another account's profile.
      if (!getProfile(body.profile, account.id)) {
        sendError(res, 404, `Profile "${body.profile}" not found`);
        return;
      }
      const threshold = body.alert_type === "auth_failure" ? null : (body.threshold ?? null);
      if (body.alert_type !== "auth_failure" && threshold === null) {
        sendError(res, 400, "Threshold required for threshold alerts");
        return;
      }
      const sub = createAlertSubscription(
        account.id,
        body.profile,
        body.alert_type as AlertType,
        threshold,
        body.channel || null,
        body.cooldown_minutes ?? 30,
      );
      sendJson(res, sub, 201);
      return;
    }

    // DELETE /api/subscriptions/:id — verifies ownership (IDOR fix: 404 on mismatch)
    if (pathname.startsWith("/api/subscriptions/") && method === "DELETE") {
      const account = accountForRequest(req);
      const id = parseInt(pathname.split("/").pop()!, 10);
      if (isNaN(id)) { sendError(res, 400, "Invalid subscription ID"); return; }
      const ok = removeAlertSubscription(account.id, id);
      if (!ok) { sendError(res, 404, "Subscription not found"); return; }
      sendJson(res, { success: true });
      return;
    }

    // GET /api/reports?granularity=daily|weekly&days=30&drill=...&profile=...&machine=...
    if (pathname === "/api/reports" && method === "GET") {
      const account = accountForRequest(req);
      const granularityParam = url.searchParams.get("granularity");
      const granularity = granularityParam === "weekly" ? "weekly" : "daily";
      let days = parseInt(url.searchParams.get("days") || "30", 10);
      if (!Number.isFinite(days) || days <= 0) days = 30;
      days = Math.min(days, 365);
      const drillParam = url.searchParams.get("drill");
      const drill: ReportDrill =
        drillParam === "machine" || drillParam === "session" || drillParam === "model" || drillParam === "account"
          ? drillParam
          : "profile";
      const profile = url.searchParams.get("profile") || undefined;
      const machine = url.searchParams.get("machine") || undefined;
      sendJson(res, getFineTokenReport({
        accountId: account.id,
        identity: account.identity,
        granularity,
        days,
        drill,
        profile,
        machine,
      }));
      return;
    }

    // GET/POST/DELETE /api/ingest-tokens — mint/list/revoke (behind oauth).
    if (pathname === "/api/ingest-tokens" && method === "GET") {
      const account = accountForRequest(req);
      sendJson(res, listIngestTokens(account.id));
      return;
    }
    if (pathname === "/api/ingest-tokens" && method === "POST") {
      const account = accountForRequest(req);
      const body = JSON.parse((await readBody(req)) || "{}");
      const machine = typeof body?.machine === "string" ? body.machine.trim() : "";
      if (!machine) { sendError(res, 400, "Missing machine name"); return; }
      const { plaintext, token } = mintIngestToken(account.id, machine);
      // Plaintext shown ONCE — never stored, never retrievable again.
      sendJson(res, {
        id: token.id,
        account: account.identity,
        machine: token.machine,
        token: plaintext,
        created_at: token.created_at,
        note: "Store this token now — it will not be shown again.",
      }, 201);
      return;
    }
    if (pathname.startsWith("/api/ingest-tokens/") && method === "DELETE") {
      const account = accountForRequest(req);
      const id = parseInt(pathname.split("/").pop()!, 10);
      if (isNaN(id)) { sendError(res, 400, "Invalid token ID"); return; }
      sendJson(res, { success: revokeIngestToken(account.id, id) });
      return;
    }

    // POST /api/ingest — machines push fine-grained token_usage + context.
    // Authenticated by a per-(account,machine) ingest token (bypasses oauth).
    // Rows are attributed to the TOKEN's account + machine — never the body.
    if (pathname === "/api/ingest" && method === "POST") {
      if (process.env.CLAUDE_PULSE_INGEST_DISABLED === "1") {
        sendError(res, 503, "Ingest disabled");
        return;
      }
      const auth = req.headers["authorization"];
      const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
        ? auth.slice(7).trim()
        : "";
      if (!bearer) { sendError(res, 401, "Missing bearer token"); return; }
      const tokenRow = validateIngestToken(bearer);
      if (!tokenRow) { sendError(res, 401, "Unauthorized"); return; }

      // M1 — per-token AND per-IP throttle (~60 req/min each). 429 when exceeded.
      const ip = (req.socket && req.socket.remoteAddress) || "unknown";
      if (!rateLimitAllow(`tok:${tokenRow.id}`) || !rateLimitAllow(`ip:${ip}`)) {
        res.setHeader("Retry-After", "1");
        sendError(res, 429, "Too many requests");
        return;
      }

      // Authoritative (account, machine) come from the token, not the body.
      const accountId = tokenRow.account_id;
      const machine = tokenRow.machine;
      upsertMachine(accountId, machine);

      let raw: string;
      try {
        raw = await readBody(req, INGEST_MAX_BYTES);
      } catch (e) {
        if ((e as Error).message === "PAYLOAD_TOO_LARGE") {
          sendError(res, 413, "Payload too large (max 1MB)");
          return;
        }
        throw e;
      }
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        sendError(res, 400, "Invalid JSON");
        return;
      }

      let upserted = 0;
      if (Array.isArray(body?.rollups)) {
        for (const r of body.rollups) {
          if (!r || typeof r !== "object") continue;
          const profile = typeof r.profile === "string" ? r.profile : "";
          const day = typeof r.day === "string" ? r.day : "";
          const model = typeof r.model === "string" ? r.model : "";
          const session_id = typeof r.session_id === "string" && r.session_id ? r.session_id : "";
          if (!profile || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !model || !session_id) continue;
          const settings = (r.settings && typeof r.settings === "object") ? r.settings : {};
          const settings_json = canonicalSettings(settings);
          const usageRow: TokenUsageInput = {
            account_id: accountId,
            profile,
            machine,
            session_id,
            model,
            settings_hash: settings_json,
            settings_json,
            day,
            tokens_in: toFiniteInt(r.tokens_in),
            tokens_out: toFiniteInt(r.tokens_out),
            cache_write_5m: toFiniteInt(r.cache_write_5m),
            cache_write_1h: toFiniteInt(r.cache_write_1h),
            cache_read: toFiniteInt(r.cache_read),
            source: "ingest",
          };
          upsertTokenUsage(usageRow);
          upserted++;
        }
      }

      let contextUpserted = 0;
      if (Array.isArray(body?.context)) {
        for (const c of body.context) {
          if (!c || typeof c !== "object") continue;
          const profile = typeof c.profile === "string" ? c.profile : "";
          const session_id = typeof c.session_id === "string" && c.session_id ? c.session_id : "";
          if (!profile || !session_id) continue;
          const settings = (c.settings && typeof c.settings === "object") ? c.settings : {};
          const ctxRow: ContextSessionInput = {
            account_id: accountId,
            profile,
            machine,
            session_id,
            model: typeof c.model === "string" ? c.model : null,
            settings_json: canonicalSettings(settings),
            context_tokens: c.context_tokens != null ? toFiniteInt(c.context_tokens) : null,
            context_pct: c.context_pct != null ? toFiniteNum(c.context_pct) : null,
            effective_limit: c.effective_limit != null ? toFiniteInt(c.effective_limit) : null,
            last_active_at: typeof c.last_active_at === "string" && c.last_active_at
              ? c.last_active_at
              : new Date().toISOString(),
          };
          upsertContextSession(ctxRow);
          contextUpserted++;
        }
      }

      sendJson(res, { ok: true, upserted, context_upserted: contextUpserted });
      return;
    }

    // GET/PUT /api/pricing · DELETE /api/pricing/:model
    if (pathname === "/api/pricing" && method === "GET") {
      const account = accountForRequest(req);
      const merged = mergePricing(getPricingDefaults(), getPricingOverrides(account.id));
      sendJson(res, { account: account.identity, rows: merged });
      return;
    }
    if (pathname === "/api/pricing" && method === "PUT") {
      const account = accountForRequest(req);
      const body = JSON.parse((await readBody(req)) || "{}");
      const rows = Array.isArray(body?.rows) ? body.rows : (body && typeof body === "object" ? [body] : []);
      let saved = 0;
      for (const r of rows) {
        if (!r || typeof r !== "object" || typeof r.model !== "string" || !r.model) continue;
        const settings = (r.settings_match && typeof r.settings_match === "object") ? r.settings_match : {};
        const override: PricingOverrideRow = {
          model: r.model,
          settings_match_json: typeof r.settings_match_json === "string"
            ? canonicalSettings(safeParseJson(r.settings_match_json) as Record<string, unknown>)
            : canonicalSettings(settings),
          input: toFiniteNum(r.input),
          output: toFiniteNum(r.output),
          cache_write_5m: toFiniteNum(r.cache_write_5m),
          cache_write_1h: toFiniteNum(r.cache_write_1h),
          cache_read: toFiniteNum(r.cache_read),
        };
        upsertPricingOverride(account.id, override);
        saved++;
      }
      const merged = mergePricing(getPricingDefaults(), getPricingOverrides(account.id));
      sendJson(res, { ok: true, saved, rows: merged });
      return;
    }
    if (pathname.startsWith("/api/pricing/") && method === "DELETE") {
      const account = accountForRequest(req);
      const model = decodeURIComponent(pathname.slice("/api/pricing/".length));
      if (!model) { sendError(res, 400, "Missing model"); return; }
      const removed = deletePricingOverride(account.id, model);
      sendJson(res, { ok: true, removed });
      return;
    }

    // POST /api/poll
    if (pathname === "/api/poll" && method === "POST") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (body.profile) {
        sendJson(res, await pollProfile(body.profile));
      } else {
        const [profiles, gemini] = await Promise.all([pollAllProfiles(), pollGeminiQuota()]);
        sendJson(res, { profiles, gemini });
      }
      return;
    }

    sendError(res, 404, "Not found");
  } catch (err) {
    if (err instanceof AuthError) {
      sendError(res, err.status, err.message);
      return;
    }
    if ((err as Error)?.message === "PAYLOAD_TOO_LARGE") {
      sendError(res, 413, "Payload too large");
      return;
    }
    log(`HTTP handler error: ${err}`);
    sendError(res, 500, "Internal server error");
  }
}

// ── Dashboard HTML ───────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-pulse</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M2 16h6l4-12 4 24 4-18 4 6h6' fill='none' stroke='%238b5cf6' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0b0b1a;--surface:#111128;--surface-2:#1a1a36;--border:#252548;
  --text:#d0d0e8;--muted:#6e6e8e;
  --green:#10b981;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6;--purple:#8b5cf6;
  --font:system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'SF Mono','Fira Code','JetBrains Mono',monospace;
}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5;min-height:100vh}
.container{max-width:1200px;margin:0 auto;padding:24px}

header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--border)}
header h1{font-size:1.5rem;font-weight:600}
header h1 span{color:var(--purple)}
.hdr-right{display:flex;gap:12px;align-items:center}
.status{font-size:.78rem;color:var(--muted);font-family:var(--mono)}

.btn{padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:.85rem;cursor:pointer;transition:all .15s;font-family:var(--font)}
.btn:hover{border-color:var(--purple);background:#1e1e40}
.btn-sm{padding:3px 10px;font-size:.75rem}
.btn-danger{border-color:var(--red);color:var(--red)}
.btn-danger:hover{background:rgba(239,68,68,.15)}

.section{margin-bottom:32px}
.section-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.section-hdr h2{font-size:1.05rem;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}

.usage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px}
.card-title{font-size:1rem;font-weight:600;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
.card-title .meta{font-size:.72rem;color:var(--muted);font-family:var(--mono);display:flex;gap:10px;align-items:center}
.win-row{margin-bottom:14px}
.win-row:last-child{margin-bottom:0}
.win-lbl{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;font-size:.85rem}
.win-lbl .pct{font-family:var(--mono);font-weight:600}
.win-lbl .resets{font-size:.72rem;color:var(--muted)}
.bar{position:relative;height:8px;background:var(--surface-2);border-radius:4px}
.bar-fill{height:100%;border-radius:4px;overflow:hidden;transition:width .4s ease}
.bar-tick{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--text);opacity:.7;border-radius:1px}
.bar-green .bar-fill{background:var(--green)}
.bar-yellow .bar-fill{background:var(--yellow)}
.bar-red .bar-fill{background:var(--red)}
.bar-none .bar-fill{background:var(--muted)}

.pace{display:inline-block;font-size:.68rem;padding:1px 7px;border-radius:10px;font-family:var(--mono);margin-left:6px}
.pace-on-track{background:rgba(16,185,129,.12);color:var(--green)}
.pace-slightly-fast{background:rgba(245,158,11,.12);color:var(--yellow)}
.pace-conserve{background:rgba(239,68,68,.12);color:var(--red)}
.pace-capacity-available{background:rgba(59,130,246,.12);color:var(--blue)}

.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;padding:8px 12px;font-weight:500;color:var(--muted);border-bottom:1px solid var(--border);font-size:.78rem}
td{padding:8px 12px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}

.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:.7rem;font-family:var(--mono)}
.badge-acked{background:rgba(16,185,129,.12);color:var(--green)}
.badge-unacked{background:rgba(245,158,11,.12);color:var(--yellow)}
.badge-type{background:rgba(139,92,246,.12);color:var(--purple)}

.form-row{display:flex;gap:8px;align-items:center;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-top:12px;flex-wrap:wrap}
.form-row select,.form-row input{padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:.85rem;font-family:var(--font)}
.form-row select:focus,.form-row input:focus{outline:none;border-color:var(--purple)}
.empty{text-align:center;padding:24px;color:var(--muted);font-size:.88rem}

.report-total{display:flex;flex-wrap:wrap;gap:16px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:16px}
.report-total .rt-item{display:flex;flex-direction:column}
.report-total .rt-item .rt-lbl{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.report-total .rt-item .rt-val{font-family:var(--mono);font-weight:600;font-size:1rem}
.report-total .rt-cost{color:var(--green)}
.rpt-cost{font-family:var(--mono);color:var(--green);font-weight:600}
.rpt-stats{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.74rem;color:var(--muted);font-family:var(--mono);margin-bottom:12px}
.rpt-stats b{color:var(--text);font-weight:600}
.spark{display:flex;align-items:flex-end;gap:2px;height:40px;margin-bottom:10px}
.spark .sbar{flex:1;background:var(--purple);border-radius:2px 2px 0 0;min-height:2px;opacity:.7}
.spark .sbar:hover{opacity:1}
.rpt-hosts{font-size:.74rem;color:var(--muted)}
.rpt-hosts .rh-row{display:flex;justify-content:space-between;padding:2px 0;border-top:1px solid var(--border)}
.rpt-hosts .rh-row:first-child{border-top:none}
.rpt-hosts .rh-host{font-family:var(--mono);color:var(--text)}
.report-total select,#rpt-granularity,#rpt-days{padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:.8rem;font-family:var(--font)}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>claude</span>-pulse</h1>
    <div class="hdr-right">
      <span class="status" id="status">loading...</span>
      <button class="btn" onclick="refresh()">Refresh</button>
      <button class="btn" onclick="pollAll()">Poll All</button>
    </div>
  </header>

  <div class="section">
    <div class="section-hdr"><h2>Usage</h2></div>
    <div class="usage-grid" id="usage-grid"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-hdr"><h2>Gemini</h2></div>
    <div class="usage-grid" id="gemini-grid"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-hdr">
      <h2>Token Reports</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="rpt-granularity" onchange="loadReports()">
          <option value="daily">daily</option>
          <option value="weekly">weekly</option>
        </select>
        <select id="rpt-days" onchange="loadReports()">
          <option value="7">7d</option>
          <option value="14">14d</option>
          <option value="30" selected>30d</option>
          <option value="90">90d</option>
        </select>
        <select id="rpt-drill" onchange="loadReports()">
          <option value="profile" selected>by profile</option>
          <option value="machine">drill: machine</option>
          <option value="session">drill: session</option>
          <option value="model">drill: model</option>
        </select>
      </div>
    </div>
    <div id="report-total" class="report-total"></div>
    <div class="usage-grid" id="report-grid"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-hdr"><h2>Sessions / Context</h2></div>
    <div id="context-grid" class="usage-grid"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-hdr">
      <h2>Settings · Machines &amp; Tokens</h2>
    </div>
    <div class="tbl-wrap">
      <table><thead><tr><th>ID</th><th>Machine</th><th>Token</th><th>Last used</th><th>Status</th><th></th></tr></thead>
      <tbody id="tokens-body"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody></table>
    </div>
    <div class="form-row">
      <input type="text" id="tok-machine" placeholder="machine name (e.g. laptop)" style="width:220px">
      <button class="btn" onclick="mintToken()">Mint ingest token</button>
      <span id="mint-result" style="font-family:var(--mono);font-size:.75rem;color:var(--green)"></span>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr"><h2>Settings · Pricing (USD per 1M tokens)</h2></div>
    <div class="tbl-wrap">
      <table><thead><tr><th>Model</th><th>Variant</th><th>Input</th><th>Output</th><th>Cache 5m</th><th>Cache 1h</th><th>Cache read</th><th></th></tr></thead>
      <tbody id="pricing-body"><tr><td colspan="8" class="empty">Loading...</td></tr></tbody></table>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr">
      <h2>Recent Alerts</h2>
      <button class="btn btn-sm" onclick="ackAll()">Acknowledge All</button>
    </div>
    <div class="tbl-wrap">
      <table><thead><tr><th>Time</th><th>Profile</th><th>Type</th><th>Message</th><th>Status</th><th></th></tr></thead>
      <tbody id="alerts-body"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody></table>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr"><h2>Subscriptions</h2></div>
    <div class="tbl-wrap">
      <table><thead><tr><th>ID</th><th>Profile</th><th>Type</th><th>Threshold</th><th>Cooldown</th><th>Status</th><th></th></tr></thead>
      <tbody id="subs-body"><tr><td colspan="7" class="empty">Loading...</td></tr></tbody></table>
    </div>
    <div class="form-row">
      <select id="sub-profile"></select>
      <select id="sub-type" onchange="toggleThreshold()">
        <option value="five_hour_threshold">5h threshold</option>
        <option value="seven_day_threshold">7d threshold</option>
        <option value="context_threshold">context threshold</option>
        <option value="auth_failure">Auth failure</option>
      </select>
      <input type="number" id="sub-threshold" placeholder="Threshold %" min="1" max="100" style="width:100px">
      <input type="number" id="sub-cooldown" placeholder="Cooldown min" value="30" min="1" style="width:110px">
      <button class="btn" onclick="createSub()">Add</button>
    </div>
  </div>
</div>

<script>
const $=s=>document.querySelector(s);

// N3 — HTML-escape any value that can originate from ingest/user data before
// putting it into innerHTML (defense-in-depth against stored XSS).
function esc(v){
  if(v===null||v===undefined)return'';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function fj(url){const r=await fetch(url);return r.json()}
async function pj(url,body={}){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json()}

function timeAgo(iso){
  if(!iso)return'—';
  const d=Date.now()-new Date(iso+(iso.endsWith('Z')?'':'Z')).getTime();
  const m=Math.floor(d/60000);
  if(m<1)return'just now';if(m<60)return m+'m ago';
  const h=Math.floor(m/60);if(h<24)return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function barColor(p){if(p===null)return'bar-none';if(p>=80)return'bar-red';if(p>=50)return'bar-yellow';return'bar-green'}
function paceClass(p){return'pace-'+p.replace(/ /g,'-')}
function fmtPct(p){return p!==null?p.toFixed(1)+'%':'\\u2014'}
function countdown(iso){
  if(!iso)return'';
  const ms=new Date(iso).getTime()-Date.now();
  if(Number.isNaN(ms))return'';
  if(ms<=0)return'resetting now';
  const m=Math.floor(ms/60000);
  if(m<60)return m+'m';
  const h=Math.floor(m/60),rm=m%60;
  if(h<24)return rm?h+'h '+rm+'m':h+'h';
  const d=Math.floor(h/24),rh=h%24;
  return rh?d+'d '+rh+'h':d+'d';
}

function renderUsage(usage,pace){
  const g=$('#usage-grid');
  if(!usage.length){g.innerHTML='<div class="empty">No profiles configured</div>';return}
  g.innerHTML=usage.map(u=>{
    const fh=pace.find(p=>p.profile===u.profile&&p.window==='5h');
    const sd=pace.find(p=>p.profile===u.profile&&p.window==='7d');
    return\`<div class="card">
      <div class="card-title">\${esc(u.profile)}<span class="meta">\${u.polled_at?timeAgo(u.polled_at):'never polled'}
        <button class="btn btn-sm" onclick="pollOne('\${esc(u.profile)}')">Poll</button></span></div>
      \${renderWin('5-hour',u.five_hour_pct,fh)}
      \${renderWin('7-day',u.seven_day_pct,sd)}
    </div>\`}).join('');
}
function renderWin(label,pct,pi){
  const v=pct!==null?pct:0,c=barColor(pct);
  const rem=pi?pi.remaining:'';
  const pb=pi?\`<span class="pace \${paceClass(pi.pace)}">\${pi.pace}</span>\`:'';
  const exp=pi&&pi.elapsed_pct!=null?\` <span class="resets">vs ~\${pi.elapsed_pct}% exp</span>\`:'';
  const tick=pi&&pi.elapsed_pct!=null?\`<div class="bar-tick" style="left:\${Math.max(0,Math.min(100,pi.elapsed_pct))}%"></div>\`:'';
  return\`<div class="win-row"><div class="win-lbl"><span>\${label} \${pb}</span><span><span class="pct">\${fmtPct(pct)}</span>\${exp}\${rem?' <span class="resets">'+rem+' left</span>':''}</span></div><div class="bar \${c}"><div class="bar-fill" style="width:\${v}%"></div>\${tick}</div></div>\`;
}

function renderGemini(quota){
  const g=$('#gemini-grid');
  if(!quota.length){g.innerHTML='<div class="empty">No Gemini quota data yet</div>';return}
  g.innerHTML=quota.map(q=>{
    const reset=countdown(q.reset_time);
    return\`<div class="card">
      <div class="card-title">\${esc(q.model_id)}<span class="meta">\${q.timestamp?timeAgo(q.timestamp):'never polled'}</span></div>
      <div class="win-row"><div class="win-lbl"><span>quota</span><span><span class="pct">\${fmtPct(q.used_pct)}</span>\${reset?' <span class="resets">'+reset+' left</span>':''}</span></div><div class="bar \${barColor(q.used_pct)}"><div class="bar-fill" style="width:\${Math.max(0,Math.min(100,q.used_pct))}%"></div></div></div>
    </div>\`}).join('');
}

function renderAlerts(alerts){
  const b=$('#alerts-body');
  if(!alerts.length){b.innerHTML='<tr><td colspan="6" class="empty">No recent alerts</td></tr>';return}
  b.innerHTML=alerts.map(a=>\`<tr>
    <td style="font-family:var(--mono);font-size:.72rem">\${timeAgo(a.triggered_at)}</td>
    <td>\${esc(a.profile)}</td>
    <td><span class="badge badge-type">\${esc(a.alert_type)}</span></td>
    <td>\${esc(a.message)}</td>
    <td>\${a.acknowledged?'<span class="badge badge-acked">acked</span>':'<span class="badge badge-unacked">pending</span>'}</td>
    <td>\${!a.acknowledged?'<button class="btn btn-sm" onclick="ackOne('+a.id+')">Ack</button>':''}</td>
  </tr>\`).join('');
}

function renderSubs(subs){
  const b=$('#subs-body');
  if(!subs.length){b.innerHTML='<tr><td colspan="7" class="empty">No subscriptions</td></tr>';return}
  b.innerHTML=subs.map(s=>\`<tr>
    <td style="font-family:var(--mono)">\${s.id}</td>
    <td>\${esc(s.profile)}</td>
    <td><span class="badge badge-type">\${esc(s.alert_type)}</span></td>
    <td>\${s.threshold!==null?s.threshold+'%':'\\u2014'}</td>
    <td>\${s.cooldown_minutes}m</td>
    <td>\${s.enabled?'<span class="badge badge-acked">active</span>':'<span class="badge badge-unacked">off</span>'}</td>
    <td><button class="btn btn-sm btn-danger" onclick="delSub(\${s.id})">Delete</button></td>
  </tr>\`).join('');
}

function fillProfiles(profiles){
  const s=$('#sub-profile');
  s.innerHTML=profiles.map(p=>'<option value="'+esc(p.name)+'">'+esc(p.name)+'</option>').join('');
}

function toggleThreshold(){
  $('#sub-threshold').style.display=$('#sub-type').value==='auth_failure'?'none':'';
}

function fmtTokens(n){
  if(n===null||n===undefined)return'\\u2014';
  if(n>=1e9)return(n/1e9).toFixed(2)+'B';
  if(n>=1e6)return(n/1e6).toFixed(2)+'M';
  if(n>=1e3)return(n/1e3).toFixed(1)+'K';
  return String(n);
}
function fmtCost(n){
  if(n===null||n===undefined)return'\\u2014';
  return '$'+(n>=100?n.toFixed(0):n.toFixed(2));
}
function renderReports(rep){
  const tot=rep.total||{tokens_in:0,tokens_out:0,cache_write_5m:0,cache_write_1h:0,cache_read:0,total_tokens:0,cost_usd:0};
  $('#report-total').innerHTML=
    '<div class="rt-item"><span class="rt-lbl">account</span><span class="rt-val">'+esc(rep.account||'—')+'</span></div>'+
    '<div class="rt-item"><span class="rt-lbl">period</span><span class="rt-val">'+rep.days+'d since '+esc(rep.since_day)+'</span></div>'+
    '<div class="rt-item"><span class="rt-lbl">total tokens</span><span class="rt-val">'+fmtTokens(tot.total_tokens)+'</span></div>'+
    '<div class="rt-item"><span class="rt-lbl">est. cost</span><span class="rt-val rt-cost">'+fmtCost(tot.cost_usd)+'</span></div>';
  const g=$('#report-grid');
  if(!rep.profiles||!rep.profiles.length){g.innerHTML='<div class="empty">No token data yet</div>';return}
  const maxCost=Math.max(...rep.profiles.flatMap(p=>p.by_day.map(d=>d.cost_usd)),0.000001);
  const drill=$('#rpt-drill')?$('#rpt-drill').value:'profile';
  g.innerHTML=rep.profiles.map(p=>{
    const spark=p.by_day.map(d=>{
      const h=Math.max(2,Math.round((d.cost_usd/maxCost)*100));
      return '<div class="sbar" style="height:'+h+'%" title="'+esc(d.day)+': '+fmtTokens(d.total_tokens)+' tok, '+fmtCost(d.cost_usd)+'"></div>';
    }).join('');
    const machines=(p.by_machine||[]).map(h=>
      '<div class="rh-row"><span class="rh-host">'+esc(h.key)+'</span><span>'+fmtTokens(h.total_tokens)+' / '+fmtCost(h.cost_usd)+'</span></div>'
    ).join('');
    const drillRows=(p.drill&&p.drill.length)?
      '<div class="rpt-hosts" style="margin-top:8px"><div class="rt-lbl" style="font-size:.66rem;margin-bottom:2px">by '+esc(drill)+'</div>'+
      p.drill.map(h=>'<div class="rh-row"><span class="rh-host">'+esc(h.key)+'</span><span>'+fmtTokens(h.total_tokens)+' / '+fmtCost(h.cost_usd)+'</span></div>').join('')+'</div>':'';
    return '<div class="card">'+
      '<div class="card-title">'+esc(p.profile)+'<span class="rpt-cost">'+fmtCost(p.cost_usd)+'</span></div>'+
      '<div class="rpt-stats"><span>total <b>'+fmtTokens(p.total_tokens)+'</b></span><span>in <b>'+fmtTokens(p.tokens_in)+'</b></span><span>out <b>'+fmtTokens(p.tokens_out)+'</b></span><span>cw5m <b>'+fmtTokens(p.cache_write_5m)+'</b></span><span>cw1h <b>'+fmtTokens(p.cache_write_1h)+'</b></span><span>cr <b>'+fmtTokens(p.cache_read)+'</b></span></div>'+
      (spark?'<div class="spark">'+spark+'</div>':'')+
      '<div class="rpt-hosts">'+machines+'</div>'+
      drillRows+
    '</div>';
  }).join('');
}
async function loadReports(){
  try{
    const gran=$('#rpt-granularity').value,days=$('#rpt-days').value;
    const drill=$('#rpt-drill')?$('#rpt-drill').value:'profile';
    const rep=await fj('/api/reports?granularity='+gran+'&days='+days+'&drill='+drill);
    renderReports(rep);
  }catch(e){$('#report-grid').innerHTML='<div class="empty">error: '+e.message+'</div>'}
}

function renderContext(groups){
  const g=$('#context-grid');
  if(!groups||!groups.length){g.innerHTML='<div class="empty">No live sessions (none active in last 24h)</div>';return}
  g.innerHTML=groups.map(grp=>{
    const machines=grp.machines.map(m=>{
      const sessions=m.sessions.map(s=>{
        const pct=s.context_pct!=null?s.context_pct:0;
        const cls=pct>=75?'bar-red':(pct>=50?'bar-yellow':'bar-green');
        const tok=s.context_tokens!=null?s.context_tokens.toLocaleString():'?';
        const lim=s.effective_context!=null?s.effective_context.toLocaleString():'?';
        const sid=esc((s.session_id||'').slice(0,8));
        return '<div class="win-row"><div class="win-lbl"><span>'+sid+' <span class="resets">'+esc(s.model||'?')+'</span></span><span><span class="pct">'+pct.toFixed(1)+'%</span> <span class="resets">'+tok+'/'+lim+'</span></span></div><div class="bar '+cls+'"><div class="bar-fill" style="width:'+Math.min(100,pct)+'%"></div></div></div>';
      }).join('');
      return '<div style="margin-bottom:10px"><div class="rt-lbl" style="font-size:.66rem;margin-bottom:4px">'+esc(m.machine)+'</div>'+sessions+'</div>';
    }).join('');
    return '<div class="card"><div class="card-title">'+esc(grp.profile)+'</div>'+machines+'</div>';
  }).join('');
}
async function loadContext(){
  try{const groups=await fj('/api/context');renderContext(groups);}
  catch(e){$('#context-grid').innerHTML='<div class="empty">error: '+e.message+'</div>'}
}

function renderTokens(tokens){
  const b=$('#tokens-body');
  if(!tokens||!tokens.length){b.innerHTML='<tr><td colspan="6" class="empty">No ingest tokens minted</td></tr>';return}
  b.innerHTML=tokens.map(t=>'<tr>'+
    '<td style="font-family:var(--mono)">'+t.id+'</td>'+
    '<td>'+esc(t.machine)+'</td>'+
    '<td style="font-family:var(--mono);font-size:.72rem">'+esc(t.token_preview)+'</td>'+
    '<td>'+(t.last_used_at?timeAgo(t.last_used_at):'never')+'</td>'+
    '<td>'+(t.revoked_at?'<span class="badge badge-unacked">revoked</span>':'<span class="badge badge-acked">active</span>')+'</td>'+
    '<td>'+(t.revoked_at?'':'<button class="btn btn-sm btn-danger" onclick="revokeToken('+t.id+')">Revoke</button>')+'</td>'+
  '</tr>').join('');
}
async function loadTokens(){
  try{const tokens=await fj('/api/ingest-tokens');renderTokens(tokens);}
  catch(e){$('#tokens-body').innerHTML='<tr><td colspan="6" class="empty">error: '+e.message+'</td></tr>'}
}
async function mintToken(){
  const machine=$('#tok-machine').value.trim();
  if(!machine){alert('Machine name required');return}
  const r=await pj('/api/ingest-tokens',{machine});
  if(r.token){$('#mint-result').textContent='Token (copy now, shown once): '+r.token;$('#tok-machine').value=''}
  else{$('#mint-result').textContent='error: '+(r.error||'failed')}
  await loadTokens();
}
async function revokeToken(id){await fetch('/api/ingest-tokens/'+id,{method:'DELETE'});await loadTokens()}

let pricingRows=[];
function renderPricing(data){
  pricingRows=data.rows||[];
  const b=$('#pricing-body');
  if(!pricingRows.length){b.innerHTML='<tr><td colspan="8" class="empty">No pricing rows</td></tr>';return}
  b.innerHTML=pricingRows.map((r,i)=>{
    const variant=(r.settings_match_json&&r.settings_match_json!=='{}')?r.settings_match_json:'base';
    const num=(k)=>'<input type="number" step="0.0001" id="pr-'+i+'-'+k+'" value="'+r[k]+'" style="width:78px;padding:3px 6px;font-family:var(--mono);font-size:.74rem">';
    return '<tr'+(r.overridden?' style="background:rgba(139,92,246,.06)"':'')+'>'+
      '<td style="font-family:var(--mono)">'+esc(r.model)+'</td>'+
      '<td style="font-family:var(--mono);font-size:.72rem">'+esc(variant)+(r.overridden?' <span class="badge badge-type">override</span>':'')+'</td>'+
      '<td>'+num('input')+'</td><td>'+num('output')+'</td><td>'+num('cache_write_5m')+'</td><td>'+num('cache_write_1h')+'</td><td>'+num('cache_read')+'</td>'+
      '<td><button class="btn btn-sm" onclick="savePricing('+i+')">Save</button>'+(r.overridden?' <button class="btn btn-sm btn-danger" onclick="resetPricing(\\''+r.model+'\\')">Reset</button>':'')+'</td>'+
    '</tr>';
  }).join('');
}
async function loadPricing(){
  try{const data=await fj('/api/pricing');renderPricing(data);}
  catch(e){$('#pricing-body').innerHTML='<tr><td colspan="8" class="empty">error: '+e.message+'</td></tr>'}
}
async function savePricing(i){
  const r=pricingRows[i];
  const g=(k)=>parseFloat($('#pr-'+i+'-'+k).value)||0;
  const row={model:r.model,settings_match_json:r.settings_match_json,input:g('input'),output:g('output'),cache_write_5m:g('cache_write_5m'),cache_write_1h:g('cache_write_1h'),cache_read:g('cache_read')};
  await fetch('/api/pricing',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(row)});
  await loadPricing();
}
async function resetPricing(model){await fetch('/api/pricing/'+encodeURIComponent(model),{method:'DELETE'});await loadPricing()}

async function refresh(){
  try{
    const[usage,gemini,pace,alerts,subs,profiles]=await Promise.all([
      fj('/api/usage'),fj('/api/gemini-quota'),fj('/api/pace'),fj('/api/alerts?hours=24'),fj('/api/subscriptions'),fj('/api/profiles')
    ]);
    renderUsage(usage,pace);renderGemini(gemini);renderAlerts(alerts);renderSubs(subs);fillProfiles(profiles);
    loadReports();loadContext();loadTokens();loadPricing();
    $('#status').textContent='updated '+new Date().toLocaleTimeString();
  }catch(e){$('#status').textContent='error: '+e.message}
}
async function pollAll(){$('#status').textContent='polling...';await pj('/api/poll');await refresh()}
async function pollOne(p){$('#status').textContent='polling '+p+'...';await pj('/api/poll',{profile:p});await refresh()}
async function ackOne(id){await pj('/api/alerts/acknowledge',{id});await refresh()}
async function ackAll(){await pj('/api/alerts/acknowledge',{});await refresh()}
async function delSub(id){await fetch('/api/subscriptions/'+id,{method:'DELETE'});await refresh()}
async function createSub(){
  const profile=$('#sub-profile').value,at=$('#sub-type').value;
  const th=at==='auth_failure'?undefined:parseFloat($('#sub-threshold').value);
  const cd=parseInt($('#sub-cooldown').value)||30;
  if(at!=='auth_failure'&&(!th||isNaN(th))){alert('Threshold required');return}
  await pj('/api/subscriptions',{profile,alert_type:at,threshold:th,cooldown_minutes:cd});
  $('#sub-threshold').value='';await refresh();
}

refresh();setInterval(refresh,30000);
</script>
</body>
</html>`;

// ── Start / Stop ─────────────────────────────────────────────────────────────

export function startHttpServer(port?: number): void {
  const p = port ?? parseInt(process.env.CLAUDE_PULSE_PORT || String(DEFAULT_PORT), 10);

  httpServer = http.createServer(handleRequest);

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(`Dashboard port ${p} already in use, HTTP server not started`);
    } else {
      log(`HTTP server error: ${err}`);
    }
  });

  httpServer.listen(p, () => {
    log(`Dashboard available at http://localhost:${p}`);
  });
}

export function stopHttpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = undefined;
    log("HTTP server stopped");
  }
}
