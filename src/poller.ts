import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PollResult, Profile, AlertEvent } from "./types.js";
import {
  insertSnapshot,
  listProfiles,
  getProfile,
  getLastSuccessfulSnapshot,
} from "./store.js";
import { checkAlerts } from "./alerts.js";
import { fetchUsage } from "./usage.js";

const activeTimers = new Map<string, ReturnType<typeof setInterval>>();
const pendingResumes = new Map<string, ReturnType<typeof setTimeout>>();

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
 * Check whether an error message indicates rate-limit / usage-window exhaustion.
 */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const text = msg.toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("usage limit") ||
    text.includes("too many requests") ||
    text.includes("429") ||
    text.includes("quota exceeded") ||
    text.includes("resource_exhausted") ||
    text.includes("overloaded") ||
    text.includes("over capacity")
  );
}

/**
 * Pick the earliest future resets_at from a set of candidates.
 */
function earliestFutureReset(...candidates: (string | null | undefined)[]): string | null {
  const now = Date.now();
  let best: string | null = null;
  let bestTime = Infinity;
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (t > now && t < bestTime) {
      best = c;
      bestTime = t;
    }
  }
  return best;
}

/**
 * Schedule a channel notification for when a usage window resets.
 * Deduplicates by profile + resetsAt so the same window isn't scheduled twice.
 */
export function scheduleWindowResume(profile: string, resetsAt: string): void {
  const key = `${profile}:${resetsAt}`;
  if (pendingResumes.has(key)) return;

  const resetTime = new Date(resetsAt).getTime();
  const resumeTime = resetTime + 60_000; // 1 minute after reset
  const delay = resumeTime - Date.now();

  if (delay <= 0) {
    log(`Reset time already passed for ${profile}, firing resume now`);
    pushChannelResume(profile, resetsAt).catch((e) =>
      log(`Failed to push immediate resume for ${profile}: ${e}`)
    );
    return;
  }

  log(
    `Scheduled window resume for ${profile} at ${new Date(resumeTime).toISOString()} (in ${Math.round(delay / 60_000)} min)`
  );

  const timer = setTimeout(async () => {
    pendingResumes.delete(key);
    try {
      await pushChannelResume(profile, resetsAt);
    } catch (e) {
      log(`Failed to push resume for ${profile}: ${e}`);
    }
  }, delay);

  timer.unref();
  pendingResumes.set(key, timer);
}

/**
 * Send a channel notification telling Claude Code the usage window has reset.
 */
async function pushChannelResume(profile: string, resetsAt: string): Promise<void> {
  if (!mcpServerInstance) return;
  try {
    await (mcpServerInstance.server as any).notification({
      method: "notifications/claude/channel",
      params: {
        content: `Usage window has reset for ${profile}. You may resume.`,
        meta: {
          event_type: "window_reset",
          profile,
          resets_at: resetsAt,
        },
      },
    });
    log(`Window reset notification pushed for ${profile}`);
  } catch (err) {
    log(`Failed to push window reset notification for ${profile}: ${err}`);
  }
}

/**
 * Cancel pending resume timers. If profile is given, only cancel that profile's timers.
 */
export function cancelPendingResumes(profile?: string): void {
  for (const [key, timer] of pendingResumes) {
    if (!profile || key.startsWith(`${profile}:`)) {
      clearTimeout(timer);
      pendingResumes.delete(key);
      log(`Cancelled pending resume: ${key}`);
    }
  }
}

/**
 * Push a channel notification for a triggered alert event.
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
 * Determine the relevant reset time for an alert event based on its type.
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

    const usage = await fetchUsage(profile);

    const snapshot = insertSnapshot(
      profile.name,
      usage.fiveHourPct,
      usage.fiveHourResetsAt,
      usage.sevenDayPct,
      usage.sevenDayResetsAt,
      usage.raw
    );

    log(
      `Poll complete for ${profile.name}: 5h=${usage.fiveHourPct}%, 7d=${usage.sevenDayPct}%`
    );

    // Check alerts after successful poll
    const alertEvents = checkAlerts(profile.name, snapshot);
    for (const evt of alertEvents) {
      const resetsAt = getResetsAt(evt, usage.fiveHourResetsAt, usage.sevenDayResetsAt);
      await pushChannelAlert(evt, profile.name, resetsAt);
    }

    return { profile: profile.name, success: true, snapshot };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Poll failed for ${profile.name}: ${errorMsg}`);

    // If rate-limited, schedule a resume notification for when the window resets
    if (isRateLimitError(err)) {
      log(`Rate-limit detected for ${profile.name}, looking for reset time`);
      const lastGood = getLastSuccessfulSnapshot(profile.name);
      const resetsAt = earliestFutureReset(
        lastGood?.five_hour_resets_at,
        lastGood?.seven_day_resets_at,
      );
      if (resetsAt) {
        scheduleWindowResume(profile.name, resetsAt);
      } else {
        log(`No future resets_at found for ${profile.name}, cannot schedule resume`);
      }
    }

    // Record a snapshot with null values on error
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
  cancelPendingResumes(profileName);
}

export function stopAllPollers(): void {
  for (const name of activeTimers.keys()) {
    stopProfileTimer(name);
  }
  cancelPendingResumes();
  log("All pollers stopped");
}
