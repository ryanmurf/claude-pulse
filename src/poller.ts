import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClaudeResponse, PollResult, Profile, AlertEvent } from "./types.js";
import {
  insertSnapshot,
  listProfiles,
  getProfile,
} from "./store.js";
import { checkAlerts } from "./alerts.js";

const execFileAsync = promisify(execFile);

const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

let mcpServerInstance: McpServer | undefined;

/**
 * Set the MCP server instance so the poller can push channel notifications
 * when alerts are triggered.
 */
export function setMcpServer(server: McpServer): void {
  mcpServerInstance = server;
}

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

/**
 * Push a channel notification for a triggered alert event.
 * Uses notifications/claude/channel so it appears as a <channel source="claude-pulse" ...> tag
 * in the Claude Code session.
 */
async function pushChannelAlert(evt: AlertEvent, profile: string, resetsAt: string | null): Promise<void> {
  if (!mcpServerInstance) return;

  const meta: Record<string, string> = {
    alert_type: evt.alert_type,
    profile,
    alert_id: String(evt.id),
  };

  if (evt.current_value !== null) {
    meta.current_value = evt.current_value.toFixed(1);
  }
  if (evt.threshold !== null) {
    meta.threshold = String(evt.threshold);
  }
  if (resetsAt) {
    meta.resets_at = resetsAt;
  }

  try {
    // Use the underlying low-level Server to send a custom notification
    // that the Claude Code channel plugin protocol understands.
    await (mcpServerInstance.server as any).notification({
      method: "notifications/claude/channel",
      params: {
        content: evt.message,
        meta,
      },
    });
    log(`Channel notification pushed for alert ${evt.id}: ${evt.message}`);
  } catch (err) {
    log(`Failed to push channel notification for alert ${evt.id}: ${err}`);
  }
}

/**
 * Determine the relevant reset time for an alert event based on its type and snapshot data.
 */
function getResetsAt(
  evt: AlertEvent,
  fiveHourResets: string | null,
  sevenDayResets: string | null
): string | null {
  if (evt.alert_type === "five_hour_threshold") return fiveHourResets;
  if (evt.alert_type === "seven_day_threshold") return sevenDayResets;
  return null;
}

export async function pollProfile(profileName: string): Promise<PollResult> {
  const profile = getProfile(profileName);
  if (!profile) {
    return { profile: profileName, success: false, error: "Profile not found" };
  }

  try {
    log(`Polling profile: ${profile.name} (config_dir: ${profile.config_dir})`);

    const { stdout } = await execFileAsync(
      "claude",
      ["-p", "say ok", "--model", "haiku", "--output-format", "json", "--bare"],
      {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: profile.config_dir,
        },
        timeout: 60_000,
      }
    );

    let parsed: ClaudeResponse;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      // Sometimes the output may have extra text before/after JSON
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Failed to parse Claude response as JSON: ${stdout.slice(0, 200)}`);
      }
    }

    const rateLimits = parsed.rate_limits;

    const fiveHourPct = rateLimits?.five_hour?.used_percentage ?? null;
    const fiveHourResets = rateLimits?.five_hour?.resets_at ?? null;
    const sevenDayPct = rateLimits?.seven_day?.used_percentage ?? null;
    const sevenDayResets = rateLimits?.seven_day?.resets_at ?? null;

    const snapshot = insertSnapshot(
      profile.name,
      fiveHourPct,
      fiveHourResets,
      sevenDayPct,
      sevenDayResets,
      stdout.trim()
    );

    log(
      `Poll complete for ${profile.name}: 5h=${fiveHourPct}%, 7d=${sevenDayPct}%`
    );

    // Check alerts after successful poll
    const alertEvents = checkAlerts(profile.name, snapshot);
    for (const evt of alertEvents) {
      const resetsAt = getResetsAt(evt, fiveHourResets, sevenDayResets);
      await pushChannelAlert(evt, profile.name, resetsAt);
    }

    return { profile: profile.name, success: true, snapshot };
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : String(err);
    log(`Poll failed for ${profile.name}: ${errorMsg}`);

    // Still record a snapshot with null values on error
    const snapshot = insertSnapshot(
      profile.name,
      null,
      null,
      null,
      null,
      JSON.stringify({ error: errorMsg })
    );

    // Check alerts after failed poll (auth_failure detection)
    const alertEvents = checkAlerts(profile.name, snapshot);
    for (const evt of alertEvents) {
      await pushChannelAlert(evt, profile.name, null);
    }

    return {
      profile: profile.name,
      success: false,
      error: errorMsg,
      snapshot,
    };
  }
}

export async function pollAllProfiles(): Promise<PollResult[]> {
  const profiles = listProfiles();
  const results: PollResult[] = [];
  for (const p of profiles) {
    const result = await pollProfile(p.name);
    results.push(result);
  }
  return results;
}

function startProfileTimer(profile: Profile): void {
  // Clear existing timer if any
  stopProfileTimer(profile.name);

  const intervalMs = profile.poll_interval_minutes * 60 * 1000;
  log(
    `Starting poll timer for ${profile.name} every ${profile.poll_interval_minutes} min`
  );

  // Do an initial poll
  pollProfile(profile.name).catch((err) => {
    log(`Initial poll error for ${profile.name}: ${err}`);
  });

  // Set up recurring interval
  const timer = setInterval(() => {
    pollProfile(profile.name).catch((err) => {
      log(`Poll error for ${profile.name}: ${err}`);
    });
  }, intervalMs);

  // Ensure the timer doesn't prevent Node from exiting
  timer.unref();

  activeTimers.set(profile.name, timer);
}

function stopProfileTimer(name: string): void {
  const existing = activeTimers.get(name);
  if (existing) {
    clearInterval(existing);
    activeTimers.delete(name);
    log(`Stopped poll timer for ${name}`);
  }
}

export function startAllPollers(): void {
  const profiles = listProfiles();
  for (const p of profiles) {
    startProfileTimer(p);
  }
  log(`Started pollers for ${profiles.length} profile(s)`);
}

export function restartPoller(profileName: string): void {
  const profile = getProfile(profileName);
  if (profile) {
    startProfileTimer(profile);
  }
}

export function stopPoller(profileName: string): void {
  stopProfileTimer(profileName);
}

export function stopAllPollers(): void {
  for (const name of activeTimers.keys()) {
    stopProfileTimer(name);
  }
  log("All pollers stopped");
}
