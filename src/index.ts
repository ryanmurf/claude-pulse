#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initDb,
  ensureDefaultProfiles,
  listProfiles,
  redactProfile,
  getProfile,
  addProfile,
  removeProfile,
  updatePollInterval,
  updateProfileBudget,
  updateProfileApiKey,
  getLatestSnapshot,
  getLatestSnapshots,
  getLatestGeminiQuota,
  getHistory,
  closeDb,
  createAlertSubscription,
  removeAlertSubscription,
  listAlertSubscriptions,
  getTriggeredAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  localAccountId,
} from "./store.js";
import {
  pollProfile,
  pollAllProfiles,
  startAllPollers,
  restartPoller,
  stopPoller,
  stopAllPollers,
  setMcpServer,
  startContextPoller,
  pollContextOnce,
  startTokenRollup,
  runTokenRollupOnce,
} from "./poller.js";
import os from "node:os";
import { getContextForProfile } from "./context.js";
import { computeUpload, pushToCentral, reportToCentral, uploadConfig } from "./upload.js";
import { runLocalBackfill } from "./backfill.js";
import { acquirePidLock, releasePidLock } from "./pidlock.js";
import { startHttpServer, stopHttpServer } from "./server.js";
import {
  formatGeminiQuotaSnapshots,
  pollGeminiQuota,
  startGeminiPoller,
  stopGeminiPoller,
} from "./gemini.js";

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

const INSTRUCTIONS = `You have a usage monitoring channel called claude-pulse. It tracks your Claude subscription usage across profiles by polling the CLI periodically.

When a usage alert fires, you'll receive a <channel source="claude-pulse" alert_type="..." profile="..." ...> event. Read the alert and take appropriate action — you might want to notify the user via Slack, adjust your behavior to conserve usage, or acknowledge the alert.

Use the claude-pulse tools to:
- list_profiles: see configured profiles and their polling intervals
- get_usage: check current usage for any profile
- get_pace: check if you're burning too fast or have room to be thorough
- get_history: view usage trends over time
- set_poll_interval: change how often a profile is polled (in minutes)
- subscribe_alert: set up threshold alerts (e.g. 90% five_hour window)
- unsubscribe_alert: remove an alert
- list_alert_subscriptions: see all configured alerts
- get_triggered_alerts: review past alert events
- acknowledge_alerts: mark alerts as handled
- poll_now: immediately poll a profile for fresh data
- add_profile / remove_profile: manage monitored subscriptions
- reply: acknowledge an alert and log a message

Default profiles:
- claude-hd (~/.claude-hd) — work subscription
- claude-max (~/.claude-max) — personal subscription

You can use the acknowledge_alerts tool or the reply tool to respond to alerts.

When a poll fails due to rate-limit exhaustion, claude-pulse automatically schedules a resume notification for 1 minute after the usage window resets. You'll receive a <channel source="claude-pulse" event_type="window_reset" profile="..." ...> event when the window has reset and you may continue working.`;

const server = new McpServer(
  { name: "claude-pulse", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
);

// --- get_pace ---
server.tool(
  "get_pace",
  "Check current usage pace — whether you're burning too fast or have room. Call this when deciding how thorough to be.",
  {
    profile: z
      .string()
      .optional()
      .describe("Profile name. Omit for all profiles."),
  },
  async ({ profile }) => {
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

    function paceForWindow(
      usedPct: number | null,
      resetsAt: string | null,
      windowKey: string,
      label: string,
    ): string | null {
      if (usedPct === null || !resetsAt) return null;
      const duration = WINDOW_DURATIONS[windowKey];
      if (!duration) return null;

      const now = Date.now();
      const resetMs = new Date(resetsAt).getTime();
      const remaining = resetMs - now;
      // resets_at in the past = the window rolled over since this snapshot was
      // taken; the pct belongs to a previous window. Extrapolating pace from it
      // produces nonsense (e.g. "1790% expected") — flag it stale instead.
      if (remaining <= 0) {
        return `${label}: ${usedPct.toFixed(0)}% used — stale (window already reset; awaiting fresh poll)`;
      }
      const elapsed = duration - remaining;
      const elapsedPct = Math.max((elapsed / duration) * 100, 1);
      const ratio = usedPct / elapsedPct;

      let pace: string;
      if (ratio > 1.5 && usedPct > 50) pace = "conserve";
      else if (ratio < 0.5 && remaining < 3_600_000) pace = "capacity available";
      else if (ratio > 1.2) pace = "slightly fast";
      else pace = "on track";

      return `${label}: ${usedPct.toFixed(0)}% used, ${formatRemaining(remaining)} left — ${pace}`;
    }

    const profilesToCheck = profile
      ? [profile]
      : (await listProfiles()).map((p) => p.name);

    const lines: string[] = [];
    for (const name of profilesToCheck) {
      const snap = await getLatestSnapshot(name);
      if (!snap) continue;
      const fh = paceForWindow(snap.five_hour_pct, snap.five_hour_resets_at, "five_hour", `${name} 5h`);
      const sd = paceForWindow(snap.seven_day_pct, snap.seven_day_resets_at, "seven_day", `${name} 7d`);
      if (fh) lines.push(fh);
      if (sd) lines.push(sd);
    }

    return {
      content: [{
        type: "text",
        text: lines.length > 0 ? lines.join("\n") : "No usage data available. Try poll_now first.",
      }],
    };
  }
);

// --- get_usage ---
server.tool(
  "get_usage",
  "Get current/latest usage for a profile or all profiles. Returns five_hour %, seven_day %, and reset times.",
  {
    profile: z
      .string()
      .optional()
      .describe(
        "Profile name to get usage for. Omit to get all profiles."
      ),
  },
  async ({ profile }) => {
    if (profile) {
      const p = await getProfile(profile);
      if (!p) {
        return {
          content: [
            { type: "text", text: `Profile "${profile}" not found.` },
          ],
        };
      }
      const snapshot = await getLatestSnapshot(profile);
      if (!snapshot) {
        return {
          content: [
            {
              type: "text",
              text: `No usage data yet for profile "${profile}". Try poll_now first.`,
            },
          ],
        };
      }
      const gemini = formatGeminiQuotaSnapshots(await getLatestGeminiQuota());
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                profile: snapshot.profile,
                five_hour_pct: snapshot.five_hour_pct,
                five_hour_resets_at: snapshot.five_hour_resets_at,
                seven_day_pct: snapshot.seven_day_pct,
                seven_day_resets_at: snapshot.seven_day_resets_at,
                polled_at: snapshot.polled_at,
                gemini,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // All profiles
    const snapshots = await getLatestSnapshots();
    const profiles = await listProfiles();
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              profiles: result,
              gemini: formatGeminiQuotaSnapshots(await getLatestGeminiQuota()),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- get_context_usage ---
server.tool(
  "get_context_usage",
  "Get current context-window usage for a profile (or all). Reads the most-recently-modified session JSONL under <config_dir>/projects/<slug>/, sums input + cache_read + cache_creation on the latest assistant turn, and computes pct against the model's effective context window. Use this to decide when to /compact.",
  {
    profile: z
      .string()
      .optional()
      .describe("Profile name. Omit for all profiles."),
    live: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, re-read JSONL right now instead of returning cached snapshot."),
  },
  async ({ profile, live }) => {
    // Optional fresh read
    if (live) {
      await pollContextOnce();
    }
    const single = profile ? await getProfile(profile) : undefined;
    const profilesToShow = profile
      ? (single ? [single] : [])
      : await listProfiles();
    if (profile && profilesToShow.length === 0) {
      return { content: [{ type: "text", text: `Profile "${profile}" not found.` }] };
    }
    const out = await Promise.all(profilesToShow.map(async (p) => {
      const snap = await getLatestSnapshot(p.name);
      if (!snap || snap.context_pct === null) {
        // Attempt one direct read for profiles that have never been polled
        const direct = p.vendor === "anthropic-oauth" ? getContextForProfile(p.config_dir) : null;
        if (!direct) {
          return { profile: p.name, context_tokens: null, context_pct: null, effective_context: null, session_id: null, model: null, last_reset_at: null, tokens_until_compact_recommended: null, polled_at: null };
        }
        return {
          profile: p.name,
          context_tokens: direct.context_tokens,
          context_pct: direct.context_pct,
          effective_context: direct.effective_context,
          session_id: direct.session_id,
          model: direct.model,
          last_reset_at: direct.last_reset_at,
          tokens_until_compact_recommended: direct.tokens_until_compact_recommended,
          polled_at: null,
        };
      }
      const tokens = snap.context_tokens ?? 0;
      const limit = snap.context_effective_limit ?? 200_000;
      const compactAt = Math.floor(limit * 0.75);
      return {
        profile: p.name,
        context_tokens: snap.context_tokens,
        context_pct: snap.context_pct,
        effective_context: snap.context_effective_limit,
        session_id: snap.context_session_id,
        model: snap.context_model,
        last_reset_at: snap.context_last_reset_at,
        tokens_until_compact_recommended: Math.max(0, compactAt - tokens),
        polled_at: snap.polled_at,
      };
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(profile ? out[0] : { profiles: out }, null, 2) }],
    };
  }
);

// --- get_context_pace ---
server.tool(
  "get_context_pace",
  "Compact one-line context pace summary per profile (similar to get_pace but for context windows).",
  {
    profile: z.string().optional().describe("Profile name. Omit for all profiles."),
  },
  async ({ profile }) => {
    const single = profile ? await getProfile(profile) : undefined;
    const profilesToShow = profile
      ? (single ? [single] : [])
      : await listProfiles();
    if (profile && profilesToShow.length === 0) {
      return { content: [{ type: "text", text: `Profile "${profile}" not found.` }] };
    }
    const lines: string[] = [];
    for (const p of profilesToShow) {
      const snap = await getLatestSnapshot(p.name);
      if (!snap || snap.context_pct === null) {
        lines.push(`${p.name} ctx: (no data)`);
        continue;
      }
      const pct = snap.context_pct;
      const tokens = snap.context_tokens ?? 0;
      const limit = snap.context_effective_limit ?? 200_000;
      let band: string;
      if (pct >= 90) band = "CRITICAL — compact now";
      else if (pct >= 75) band = "high — consider /compact";
      else if (pct >= 50) band = "moderate";
      else band = "ok";
      lines.push(
        `${p.name} ctx: ${pct.toFixed(1)}% (${tokens.toLocaleString()}/${limit.toLocaleString()}, model=${snap.context_model ?? "?"}) — ${band}`
      );
    }
    return {
      content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No context data." }],
    };
  }
);

// --- get_gemini_quota ---
server.tool(
  "get_gemini_quota",
  "Get current/latest Gemini consumer-tier quota by model. Returns used_pct and reset_time per bucket.",
  {},
  async () => {
    const quota = formatGeminiQuotaSnapshots(await getLatestGeminiQuota());
    if (quota.length === 0) {
      return {
        content: [{ type: "text", text: "No Gemini quota data available yet." }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(quota, null, 2) }],
    };
  }
);

// --- get_history ---
server.tool(
  "get_history",
  "Get usage history for a profile over a time window.",
  {
    profile: z.string().describe("Profile name"),
    hours: z
      .number()
      .optional()
      .default(24)
      .describe("Number of hours of history to retrieve (default 24)"),
    limit: z
      .number()
      .optional()
      .default(100)
      .describe("Maximum number of records to return (default 100)"),
  },
  async ({ profile, hours, limit }) => {
    const p = await getProfile(profile);
    if (!p) {
      return {
        content: [
          { type: "text", text: `Profile "${profile}" not found.` },
        ],
      };
    }

    const history = await getHistory(profile, hours, limit);
    const result = history.map((s) => ({
      five_hour_pct: s.five_hour_pct,
      five_hour_resets_at: s.five_hour_resets_at,
      seven_day_pct: s.seven_day_pct,
      seven_day_resets_at: s.seven_day_resets_at,
      polled_at: s.polled_at,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { profile, hours, count: result.length, history: result },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- set_poll_interval ---
server.tool(
  "set_poll_interval",
  "Update polling frequency for a profile.",
  {
    profile: z.string().describe("Profile name"),
    interval_minutes: z
      .number()
      .min(1)
      .describe("Polling interval in minutes (minimum 1)"),
  },
  async ({ profile, interval_minutes }) => {
    const updated = await updatePollInterval(profile, interval_minutes);
    if (!updated) {
      return {
        content: [
          { type: "text", text: `Profile "${profile}" not found.` },
        ],
      };
    }
    await restartPoller(profile);
    return {
      content: [
        {
          type: "text",
          text: `Updated poll interval for "${profile}" to ${interval_minutes} minute(s). Poller restarted.`,
        },
      ],
    };
  }
);

// --- list_profiles ---
server.tool(
  "list_profiles",
  "List all configured profiles with their config dirs and poll intervals.",
  {},
  async () => {
    const profiles = (await listProfiles()).map(redactProfile);
    return {
      content: [{ type: "text", text: JSON.stringify(profiles, null, 2) }],
    };
  }
);

// --- add_profile ---
server.tool(
  "add_profile",
  "Add a new profile. Vendor controls how usage is polled: 'anthropic-oauth' (default) reads OAuth tokens from config_dir; 'deepseek-balance' polls the DeepSeek balance API and computes % from monthly_budget_usd; 'openai-codex' reads the Codex CLI session rate_limits from config_dir (e.g. ~/.codex); 'antigravity' tallies token usage from the Antigravity CLI conversation .db files under config_dir/conversations (e.g. ~/.gemini/antigravity-cli) — token tally only, no 5h/7d rate-limit polling.",
  {
    name: z.string().describe("Profile name (unique identifier)"),
    config_dir: z.string().describe("Path to CLAUDE_CONFIG_DIR for this profile"),
    poll_interval_minutes: z
      .number()
      .optional()
      .default(5)
      .describe("Polling interval in minutes (default 5)"),
    vendor: z
      .enum(["anthropic-oauth", "deepseek-balance", "openai-codex", "antigravity"])
      .optional()
      .default("anthropic-oauth")
      .describe("Usage data source. Default 'anthropic-oauth'."),
    monthly_budget_usd: z
      .number()
      .optional()
      .describe("Monthly USD budget — required for 'deepseek-balance' to compute %."),
    api_key: z
      .string()
      .optional()
      .describe("API key for balance-vendor profiles (e.g. DeepSeek sk-...). Required for 'deepseek-balance'."),
  },
  async ({ name, config_dir, poll_interval_minutes, vendor, monthly_budget_usd, api_key }) => {
    const existing = await getProfile(name);
    if (existing) {
      return {
        content: [
          {
            type: "text",
            text: `Profile "${name}" already exists. Remove it first to recreate.`,
          },
        ],
      };
    }

    if (vendor === "deepseek-balance" && !api_key) {
      return {
        content: [{ type: "text", text: "vendor=deepseek-balance requires api_key." }],
      };
    }

    const profile = await addProfile(
      name,
      config_dir,
      poll_interval_minutes,
      vendor,
      monthly_budget_usd ?? null,
      api_key ?? null
    );
    await restartPoller(name);
    return {
      content: [
        {
          type: "text",
          text: `Profile added and poller started:\n${JSON.stringify(redactProfile(profile), null, 2)}`,
        },
      ],
    };
  }
);

// --- set_budget ---
server.tool(
  "set_budget",
  "Set or clear the monthly USD budget for a balance-vendor profile (e.g. claude-deepseek). Pass null/omit monthly_budget_usd to clear.",
  {
    name: z.string().describe("Profile name"),
    monthly_budget_usd: z.number().nullable().optional().describe("Monthly budget in USD; null/omit to clear"),
  },
  async ({ name, monthly_budget_usd }) => {
    const profile = await getProfile(name);
    if (!profile) {
      return { content: [{ type: "text", text: `Profile "${name}" not found.` }] };
    }
    await updateProfileBudget(name, monthly_budget_usd ?? null);
    return {
      content: [
        {
          type: "text",
          text: `Set monthly_budget_usd=${monthly_budget_usd ?? "null"} for ${name}. Re-poll to see updated %.`,
        },
      ],
    };
  }
);

// --- set_api_key ---
server.tool(
  "set_api_key",
  "Set or rotate the API key for a balance-vendor profile (e.g. DeepSeek sk-...). Pass null/omit api_key to clear.",
  {
    name: z.string().describe("Profile name"),
    api_key: z.string().nullable().optional().describe("API key value; null/omit to clear"),
  },
  async ({ name, api_key }) => {
    const profile = await getProfile(name);
    if (!profile) {
      return { content: [{ type: "text", text: `Profile "${name}" not found.` }] };
    }
    await updateProfileApiKey(name, api_key ?? null);
    return {
      content: [
        {
          type: "text",
          text: `Updated api_key for ${name}.`,
        },
      ],
    };
  }
);

// --- remove_profile ---
server.tool(
  "remove_profile",
  "Remove a profile and stop its poller.",
  {
    name: z.string().describe("Profile name to remove"),
  },
  async ({ name }) => {
    stopPoller(name);
    const removed = await removeProfile(name);
    if (!removed) {
      return {
        content: [
          { type: "text", text: `Profile "${name}" not found.` },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Profile "${name}" removed and poller stopped.`,
        },
      ],
    };
  }
);

// --- poll_now ---
server.tool(
  "poll_now",
  "Immediately poll a specific profile or all profiles.",
  {
    profile: z
      .string()
      .optional()
      .describe("Profile name to poll. Omit to poll all profiles."),
  },
  async ({ profile }) => {
    if (profile) {
      const result = await pollProfile(profile);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    const [results, gemini] = await Promise.all([pollAllProfiles(), pollGeminiQuota()]);
    return {
      content: [{ type: "text", text: JSON.stringify({ profiles: results, gemini }, null, 2) }],
    };
  }
);

// --- subscribe_alert ---
server.tool(
  "subscribe_alert",
  "Create an alert subscription for a profile. Alerts trigger when usage exceeds a threshold or auth fails.",
  {
    profile: z.string().describe("Profile name to subscribe alerts for"),
    alert_type: z
      .enum(["five_hour_threshold", "seven_day_threshold", "auth_failure", "context_threshold"])
      .describe("Type of alert. context_threshold fires when the current session's context-window % exceeds the threshold (use to drive auto-/compact)."),
    threshold: z
      .number()
      .optional()
      .describe(
        "Usage percentage threshold (e.g. 90.0). Required for threshold alerts, ignored for auth_failure."
      ),
    channel: z
      .string()
      .optional()
      .describe("Slack channel ID for routing context (optional)"),
    cooldown_minutes: z
      .number()
      .optional()
      .default(30)
      .describe("Minimum minutes between repeated alerts (default 30)"),
  },
  async ({ profile, alert_type, threshold, channel, cooldown_minutes }) => {
    const p = await getProfile(profile);
    if (!p) {
      return {
        content: [
          { type: "text", text: `Profile "${profile}" not found.` },
        ],
      };
    }

    if (alert_type !== "auth_failure" && (threshold === undefined || threshold === null)) {
      return {
        content: [
          {
            type: "text",
            text: `Threshold is required for alert type "${alert_type}".`,
          },
        ],
      };
    }

    const sub = await createAlertSubscription(
      await localAccountId(),
      profile,
      alert_type,
      alert_type === "auth_failure" ? null : (threshold ?? null),
      channel ?? null,
      cooldown_minutes
    );

    return {
      content: [
        {
          type: "text",
          text: `Alert subscription created:\n${JSON.stringify(sub, null, 2)}`,
        },
      ],
    };
  }
);

// --- unsubscribe_alert ---
server.tool(
  "unsubscribe_alert",
  "Remove an alert subscription by ID.",
  {
    id: z.number().describe("Alert subscription ID to remove"),
  },
  async ({ id }) => {
    const removed = await removeAlertSubscription(await localAccountId(), id);
    if (!removed) {
      return {
        content: [
          {
            type: "text",
            text: `Alert subscription ${id} not found.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Alert subscription ${id} removed.`,
        },
      ],
    };
  }
);

// --- list_alert_subscriptions ---
server.tool(
  "list_alert_subscriptions",
  "List all alert subscriptions, optionally filtered by profile.",
  {
    profile: z
      .string()
      .optional()
      .describe("Profile name to filter by. Omit to list all."),
  },
  async ({ profile }) => {
    const subs = await listAlertSubscriptions(await localAccountId(), profile);
    if (subs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: profile
              ? `No alert subscriptions for profile "${profile}".`
              : "No alert subscriptions configured.",
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(subs, null, 2) }],
    };
  }
);

// --- get_triggered_alerts ---
server.tool(
  "get_triggered_alerts",
  "Get alert events that have been triggered. Optionally filter by profile, time window, and acknowledgment status.",
  {
    profile: z
      .string()
      .optional()
      .describe("Profile name to filter by. Omit to get all."),
    hours: z
      .number()
      .optional()
      .default(24)
      .describe("Number of hours to look back (default 24)"),
    unacknowledged_only: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return unacknowledged alerts (default false)"),
  },
  async ({ profile, hours, unacknowledged_only }) => {
    const events = await getTriggeredAlerts(await localAccountId(), profile, hours, unacknowledged_only);
    if (events.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No triggered alerts found for the given criteria.",
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
    };
  }
);

// --- acknowledge_alerts ---
server.tool(
  "acknowledge_alerts",
  "Acknowledge alert events. Provide an id to ack one, a profile to ack all for that profile, or neither to ack all.",
  {
    id: z
      .number()
      .optional()
      .describe("Specific alert event ID to acknowledge"),
    profile: z
      .string()
      .optional()
      .describe(
        "Acknowledge all alerts for this profile. Ignored if id is provided."
      ),
  },
  async ({ id, profile }) => {
    if (id !== undefined) {
      const acked = await acknowledgeAlert(await localAccountId(), id);
      return {
        content: [
          {
            type: "text",
            text: acked
              ? `Alert ${id} acknowledged.`
              : `Alert ${id} not found or already acknowledged.`,
          },
        ],
      };
    }

    const count = await acknowledgeAllAlerts(await localAccountId(), profile);
    const scope = profile ? `for profile "${profile}"` : "across all profiles";
    return {
      content: [
        {
          type: "text",
          text:
            count > 0
              ? `Acknowledged ${count} alert(s) ${scope}.`
              : `No unacknowledged alerts found ${scope}.`,
        },
      ],
    };
  }
);

// --- reply ---
server.tool(
  "reply",
  "Acknowledge a usage alert and log a message. Use this to respond to channel alert events.",
  {
    alert_id: z
      .number()
      .optional()
      .describe("Alert event ID to acknowledge. If omitted, just logs the message."),
    message: z
      .string()
      .describe("Message to log as your response to the alert."),
  },
  async ({ alert_id, message }) => {
    let ackResult = "";
    if (alert_id !== undefined) {
      const acked = await acknowledgeAlert(await localAccountId(), alert_id);
      ackResult = acked
        ? `Alert ${alert_id} acknowledged. `
        : `Alert ${alert_id} not found or already acknowledged. `;
    }
    log(`Reply: ${message}`);
    return {
      content: [
        {
          type: "text",
          text: `${ackResult}Message logged: ${message}`,
        },
      ],
    };
  }
);

// --- Upload mode ---
// Remote machines run this from cron: compute local rollups for all profiles
// and POST them to a central claude-pulse server's /api/ingest, chunked under the
// server's 1MB cap. Does NOT start the HTTP server or pollers. Exits 0 on success.
//
//   - default            → last UPLOAD_LOOKBACK_DAYS days (incremental).
//   - CLAUDE_PULSE_UPLOAD_BACKFILL=1 (or --backfill) → FULL-HISTORY one-shot.
const UPLOAD_LOOKBACK_DAYS = 2;

function lookbackDay(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function uploadOnce(opts?: { backfill?: boolean }): Promise<number> {
  const cfg = uploadConfig();
  if (!process.env.CLAUDE_PULSE_UPLOAD_TO) {
    log("Upload mode: CLAUDE_PULSE_UPLOAD_TO is not set");
    return 1;
  }
  if (!process.env.CLAUDE_PULSE_INGEST_TOKEN) {
    log("Upload mode: CLAUDE_PULSE_INGEST_TOKEN is not set");
    return 1;
  }
  if (!cfg) return 1;

  await initDb();
  await ensureDefaultProfiles();

  const host = os.hostname();
  const backfill = opts?.backfill === true;
  // Full history (sinceDays:null) for backfill; otherwise the incremental window.
  const sinceDay = backfill ? undefined : lookbackDay(UPLOAD_LOOKBACK_DAYS);
  const tallyOpts = backfill ? { sinceDays: null } : undefined;

  try {
    const { rollups, context, snapshots, gemini } = await computeUpload(
      sinceDay,
      tallyOpts,
      undefined,
      { snapshots: true, gemini: true },
    );
    log(
      `Upload mode${backfill ? " (FULL-HISTORY backfill)" : ""}: computed ${rollups.length} token_usage row(s) + ${context.length} context session(s) + ${snapshots.length} snapshot(s) + ${gemini.length} gemini bucket(s) for host ${host}; POSTing to ${cfg.baseUrl}/api/ingest`,
    );
    const res = await pushToCentral(rollups, context, cfg, { snapshots, gemini });
    log(
      `Upload mode: ${res.ok}/${res.chunks} chunk(s) OK, ${res.failed} failed`,
    );
    return res.failed > 0 ? 1 : 0;
  } catch (e) {
    log(`Upload mode: failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await closeDb();
  }
}

/**
 * Full-history upload backfill for long-running modes. Assumes DB is already
 * initialized (the daemon has). Computes the full history once and pushes it to
 * central in chunks; does NOT close the DB (the loops keep running). No-op when
 * upload is unconfigured.
 */
async function runUploadBackfill(): Promise<void> {
  const cfg = uploadConfig();
  if (!cfg) {
    log("Upload backfill: CLAUDE_PULSE_UPLOAD_TO / CLAUDE_PULSE_INGEST_TOKEN not set — skipping");
    return;
  }
  const host = os.hostname();
  const { rollups, context, snapshots, gemini } = await computeUpload(
    undefined,
    { sinceDays: null },
    undefined,
    { snapshots: true, gemini: true },
  );
  log(
    `Upload backfill (full-history): computed ${rollups.length} token_usage row(s) + ${context.length} context session(s) + ${snapshots.length} snapshot(s) + ${gemini.length} gemini bucket(s) for host ${host}; POSTing to ${cfg.baseUrl}/api/ingest`,
  );
  const res = await pushToCentral(rollups, context, cfg, { snapshots, gemini });
  log(`Upload backfill: ${res.ok}/${res.chunks} chunk(s) OK, ${res.failed} failed`);
}

// --- Agent daemon mode ---
// A long-lived local collector. Given CLAUDE_PULSE_UPLOAD_TO + INGEST_TOKEN, it
// polls each signal LOCALLY on its own fast cadence, writes its own local store
// (the working set), then PUSHES to the central server's /api/ingest. Every
// signal loop is fail-soft: a failing signal/HTTP error logs + backs off but
// never kills the daemon or the other loops.
const AGENT_DEFAULTS = {
  context: 30_000, // 30s
  usage: 180_000, // 180s
  tokens: 180_000, // 180s
  gemini: 300_000, // 300s
};

function envInterval(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

/** Compute current 5h/7d snapshots locally, write them locally, and push to central. */
async function agentPushSnapshots(): Promise<void> {
  // Local write (per-profile snapshot rows on this machine's local store).
  await pollAllProfiles();
  // Compute the upload shape + push (account-level, latest-wins on the server).
  const cfg = uploadConfig();
  if (!cfg) return;
  const { snapshots } = await computeUpload(undefined, undefined, undefined, { snapshots: true });
  if (snapshots.length > 0) {
    await reportToCentral([], [], cfg, { snapshots });
  }
}

/** Fetch gemini quota once, store locally, and push to central. */
async function agentPushGemini(): Promise<void> {
  const cfg = uploadConfig();
  if (!cfg) return;
  // Local store write (default/local account) + compute upload buckets.
  await pollGeminiQuota();
  const { gemini } = await computeUpload(undefined, undefined, [], { gemini: true });
  if (gemini.length > 0) {
    await reportToCentral([], [], cfg, { gemini });
  }
}

function startAgentLoop(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
): ReturnType<typeof setInterval> {
  const run = (): void => {
    fn().catch((e) => log(`agent ${name}: ${(e as Error).message}`));
  };
  run(); // immediate first pass
  const timer = setInterval(run, intervalMs);
  // NOTE: do NOT unref() — in agent daemon mode there is no HTTP server to keep
  // the event loop alive, so an unref'd timer lets the process exit cleanly after
  // the first pass. Keeping it ref'd is what makes the daemon stay running.
  log(`agent: ${name} loop every ${Math.round(intervalMs / 1000)}s`);
  return timer;
}

async function agentDaemon(): Promise<void> {
  const cfg = uploadConfig();
  if (!cfg) {
    log("Agent mode requires CLAUDE_PULSE_UPLOAD_TO + CLAUDE_PULSE_INGEST_TOKEN");
    process.exit(1);
    return;
  }

  // Singleton guard: stacked daemon starts (nohup restarts on top of a
  // systemd-managed instance) once left FOUR daemons polling in parallel,
  // 429-throttling the usage API for every profile. Exactly one agent daemon
  // per pidfile (per machine by default).
  const lock = acquirePidLock();
  if (!lock.acquired) {
    log(
      `Another claude-pulse agent daemon is already running (pid ${lock.holderPid}, pidfile ${lock.pidFile}). ` +
        `Refusing to start a duplicate — parallel daemons multiply poll traffic and rate-limit the usage API. ` +
        `Stop the existing daemon first (e.g. systemctl --user stop claude-pulse-agent, or kill ${lock.holderPid}).`,
    );
    process.exit(1);
    return;
  }

  log(`Initializing claude-pulse agent (pushing to ${cfg.baseUrl})...`);
  await initDb();
  await ensureDefaultProfiles();

  // Optional one-time full-history backfill before the incremental loops start.
  if (process.env.CLAUDE_PULSE_UPLOAD_BACKFILL === "1" || process.argv.includes("--backfill")) {
    try {
      await runUploadBackfill();
    } catch (e) {
      log(`Agent backfill error: ${(e as Error).message}`);
    }
  }

  const intervals = {
    context: envInterval("CLAUDE_PULSE_PUSH_CONTEXT_INTERVAL", AGENT_DEFAULTS.context),
    usage: envInterval("CLAUDE_PULSE_PUSH_USAGE_INTERVAL", AGENT_DEFAULTS.usage),
    tokens: envInterval("CLAUDE_PULSE_PUSH_TOKENS_INTERVAL", AGENT_DEFAULTS.tokens),
    gemini: envInterval("CLAUDE_PULSE_PUSH_GEMINI_INTERVAL", AGENT_DEFAULTS.gemini),
  };

  // Each loop writes locally then pushes; all are independent + fail-soft.
  const timers = [
    // context: pollContextOnce() writes local context_sessions + pushes context.
    startAgentLoop("context", intervals.context, () => pollContextOnce()),
    // usage 5h/7d snapshots.
    startAgentLoop("usage", intervals.usage, () => agentPushSnapshots()),
    // token rollups (last-2-day window): runTokenRollupOnce writes local + pushes.
    startAgentLoop("tokens", intervals.tokens, () => runTokenRollupOnce(2)),
    // gemini quota.
    startAgentLoop("gemini", intervals.gemini, () => agentPushGemini()),
  ];

  log("Agent daemon running (Ctrl-C to stop)");

  const shutdown = (): void => {
    log("Agent shutting down...");
    for (const t of timers) clearInterval(t);
    releasePidLock(lock.pidFile);
    void closeDb().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Last-resort cleanup for non-signal exits (sync-only handler). SIGKILL still
  // leaves the file behind — the stale-pid takeover in acquirePidLock covers it.
  process.on("exit", () => releasePidLock(lock.pidFile));
}

// --- Main ---
async function main(): Promise<void> {
  log("Initializing claude-pulse channel plugin...");

  // Initialize DB and default profiles
  await initDb();
  await ensureDefaultProfiles();
  log("Database initialized with default profiles");

  const serverOnly = process.env.CLAUDE_PULSE_SERVER_ONLY === "1";
  // Receiver-only: the central server is a PURE receiver. It serves the UI/API and
  // accepts ingest, but runs NO local-file pollers (it has no config-dir access).
  // Only meaningful alongside server-only.
  const receiverOnly = serverOnly && process.env.CLAUDE_PULSE_RECEIVER_ONLY === "1";

  // Optional full-history backfills (before the normal loops start).
  // Local backfill: write every profile's full history into the local DB.
  if (process.env.CLAUDE_PULSE_BACKFILL === "1") {
    try {
      await runLocalBackfill();
    } catch (e) {
      log(`Local backfill error: ${(e as Error).message}`);
    }
  }
  // Upload backfill: compute full history + push to central (chunked), then the
  // continuous loops below keep incremental reporting going.
  if (process.env.CLAUDE_PULSE_UPLOAD_BACKFILL === "1" || process.argv.includes("--backfill")) {
    try {
      await runUploadBackfill();
    } catch (e) {
      log(`Upload backfill error: ${(e as Error).message}`);
    }
  }

  // Give the poller access to the MCP server for channel notifications
  // (skip in server-only mode — there is no MCP client / stdio transport)
  if (!serverOnly) {
    setMcpServer(server);
  }

  // Start background pollers — UNLESS receiver-only (pure central receiver has no
  // local files to poll; it only serves the UI/API + accepts ingest).
  if (!receiverOnly) {
    await startAllPollers();
    startGeminiPoller();
    startContextPoller();
    startTokenRollup();
  } else {
    log("Receiver-only mode: skipping all local pollers (pure receiver)");
  }

  // Start HTTP dashboard
  startHttpServer();

  if (serverOnly) {
    log(
      receiverOnly
        ? "Receiver-only mode: HTTP dashboard + ingest only (no pollers, no MCP stdio transport)"
        : "Server-only mode: HTTP dashboard + pollers running (no MCP stdio transport)"
    );
  } else {
    // Connect MCP server via stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("Channel plugin connected via stdio");
  }

  // Graceful shutdown
  const shutdown = (): void => {
    log("Shutting down...");
    stopAllPollers();
    stopGeminiPoller();
    stopHttpServer();
    void closeDb().finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// One-time data migration entrypoint. Explicit only — never part of normal
// startup. Copies the local SQLite usage.db into the Postgres target defined by
// CLAUDE_PULSE_PG_URL / CLAUDE_PULSE_PG_*. See src/migrate-sqlite-to-pg.ts.
const migrateMode = process.argv.includes("--migrate-sqlite-to-pg");

const uploadMode =
  process.env.CLAUDE_PULSE_MODE === "upload" || process.argv.includes("--upload-once");

// Continuous local-collector daemon: polls locally + pushes each signal on its
// own cadence. Gated by CLAUDE_PULSE_AGENT=1 (or CLAUDE_PULSE_MODE=agent).
const agentMode =
  process.env.CLAUDE_PULSE_AGENT === "1" ||
  process.env.CLAUDE_PULSE_MODE === "agent" ||
  process.argv.includes("--agent");

// A backfill requested via env/flag. In one-shot upload mode this makes the
// single push a FULL-HISTORY push, then exit.
const wantBackfill =
  process.env.CLAUDE_PULSE_UPLOAD_BACKFILL === "1" || process.argv.includes("--backfill");

if (migrateMode) {
  // Lazy import so the migration module (and its pg use) only loads on demand.
  import("./migrate-sqlite-to-pg.js")
    .then(({ migrateSqliteToPg }) => migrateSqliteToPg())
    .then((counts) => {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      process.stdout.write(
        `Migrated ${total} rows across ${Object.keys(counts).length} tables.\n`,
      );
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`[claude-pulse] Migration fatal error: ${err?.message || err}\n`);
      process.exit(1);
    });
} else if (uploadMode) {
  uploadOnce({ backfill: wantBackfill })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[claude-pulse] Upload fatal error: ${err}\n`);
      process.exit(1);
    });
} else if (agentMode) {
  agentDaemon().catch((err) => {
    process.stderr.write(`[claude-pulse] Agent fatal error: ${err}\n`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    process.stderr.write(`[claude-pulse] Fatal error: ${err}\n`);
    process.exit(1);
  });
}
