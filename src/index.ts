#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initDb,
  ensureDefaultProfiles,
  listProfiles,
  getProfile,
  addProfile,
  removeProfile,
  updatePollInterval,
  getLatestSnapshot,
  getLatestSnapshots,
  getHistory,
  closeDb,
  createAlertSubscription,
  removeAlertSubscription,
  listAlertSubscriptions,
  getTriggeredAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
} from "./store.js";
import {
  pollProfile,
  pollAllProfiles,
  startAllPollers,
  restartPoller,
  stopPoller,
  stopAllPollers,
  setMcpServer,
} from "./poller.js";
import { startHttpServer, stopHttpServer } from "./server.js";

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
      : listProfiles().map((p) => p.name);

    const lines: string[] = [];
    for (const name of profilesToCheck) {
      const snap = getLatestSnapshot(name);
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
      const p = getProfile(profile);
      if (!p) {
        return {
          content: [
            { type: "text", text: `Profile "${profile}" not found.` },
          ],
        };
      }
      const snapshot = getLatestSnapshot(profile);
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
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // All profiles
    const snapshots = getLatestSnapshots();
    const profiles = listProfiles();
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
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
    const p = getProfile(profile);
    if (!p) {
      return {
        content: [
          { type: "text", text: `Profile "${profile}" not found.` },
        ],
      };
    }

    const history = getHistory(profile, hours, limit);
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
    const updated = updatePollInterval(profile, interval_minutes);
    if (!updated) {
      return {
        content: [
          { type: "text", text: `Profile "${profile}" not found.` },
        ],
      };
    }
    restartPoller(profile);
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
    const profiles = listProfiles();
    return {
      content: [{ type: "text", text: JSON.stringify(profiles, null, 2) }],
    };
  }
);

// --- add_profile ---
server.tool(
  "add_profile",
  "Add a new profile with name, config_dir, and optional poll_interval.",
  {
    name: z.string().describe("Profile name (unique identifier)"),
    config_dir: z.string().describe("Path to CLAUDE_CONFIG_DIR for this profile"),
    poll_interval_minutes: z
      .number()
      .optional()
      .default(5)
      .describe("Polling interval in minutes (default 5)"),
  },
  async ({ name, config_dir, poll_interval_minutes }) => {
    const existing = getProfile(name);
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

    const profile = addProfile(name, config_dir, poll_interval_minutes);
    restartPoller(name);
    return {
      content: [
        {
          type: "text",
          text: `Profile added and poller started:\n${JSON.stringify(profile, null, 2)}`,
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
    const removed = removeProfile(name);
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

    const results = await pollAllProfiles();
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
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
      .enum(["five_hour_threshold", "seven_day_threshold", "auth_failure"])
      .describe("Type of alert"),
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
    const p = getProfile(profile);
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

    const sub = createAlertSubscription(
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
    const removed = removeAlertSubscription(id);
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
    const subs = listAlertSubscriptions(profile);
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
    const events = getTriggeredAlerts(profile, hours, unacknowledged_only);
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
      const acked = acknowledgeAlert(id);
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

    const count = acknowledgeAllAlerts(profile);
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
      const acked = acknowledgeAlert(alert_id);
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

// --- Main ---
async function main(): Promise<void> {
  log("Initializing claude-pulse channel plugin...");

  // Initialize DB and default profiles
  initDb();
  ensureDefaultProfiles();
  log("Database initialized with default profiles");

  // Give the poller access to the MCP server for channel notifications
  setMcpServer(server);

  // Start background pollers
  startAllPollers();

  // Start HTTP dashboard
  startHttpServer();

  // Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Channel plugin connected via stdio");

  // Graceful shutdown
  const shutdown = (): void => {
    log("Shutting down...");
    stopAllPollers();
    stopHttpServer();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[claude-pulse] Fatal error: ${err}\n`);
  process.exit(1);
});
