import type { UsageSnapshot, AlertEvent } from "./types.js";
import {
  getEnabledAlertSubscriptions,
  getLastAlertEvent,
  createAlertEvent,
} from "./store.js";

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

/**
 * Check all enabled alert subscriptions for a profile against the latest snapshot.
 * Creates alert events for any triggered alerts (respecting cooldown).
 * Returns the list of newly created alert events.
 */
export function checkAlerts(
  profile: string,
  snapshot: UsageSnapshot
): AlertEvent[] {
  const subscriptions = getEnabledAlertSubscriptions(profile);
  const triggered: AlertEvent[] = [];

  for (const sub of subscriptions) {
    let shouldAlert = false;
    let currentValue: number | null = null;
    let message = "";

    switch (sub.alert_type) {
      case "five_hour_threshold": {
        if (
          snapshot.five_hour_pct !== null &&
          sub.threshold !== null &&
          snapshot.five_hour_pct >= sub.threshold
        ) {
          shouldAlert = true;
          currentValue = snapshot.five_hour_pct;
          message = `Usage alert: ${profile} 5-hour window at ${snapshot.five_hour_pct.toFixed(1)}% (threshold: ${sub.threshold}%)`;
        }
        break;
      }
      case "seven_day_threshold": {
        if (
          snapshot.seven_day_pct !== null &&
          sub.threshold !== null &&
          snapshot.seven_day_pct >= sub.threshold
        ) {
          shouldAlert = true;
          currentValue = snapshot.seven_day_pct;
          message = `Usage alert: ${profile} 7-day window at ${snapshot.seven_day_pct.toFixed(1)}% (threshold: ${sub.threshold}%)`;
        }
        break;
      }
      case "auth_failure": {
        if (
          snapshot.five_hour_pct === null &&
          snapshot.seven_day_pct === null
        ) {
          shouldAlert = true;
          message = `Auth failure: ${profile} failed to authenticate during poll`;
        }
        break;
      }
    }

    if (!shouldAlert) continue;

    // Check cooldown: skip if last alert for this subscription is within cooldown window
    const lastEvent = getLastAlertEvent(sub.id);
    if (lastEvent) {
      const lastTriggered = new Date(lastEvent.triggered_at + "Z").getTime();
      const cooldownMs = sub.cooldown_minutes * 60 * 1000;
      const now = Date.now();
      if (now - lastTriggered < cooldownMs) {
        log(
          `Alert cooldown active for subscription ${sub.id} (${sub.alert_type} on ${profile}), skipping`
        );
        continue;
      }
    }

    // Create the alert event
    const event = createAlertEvent(
      sub.id,
      profile,
      sub.alert_type,
      message,
      currentValue,
      sub.threshold
    );
    triggered.push(event);
    log(`Alert triggered: ${message}`);
  }

  return triggered;
}
