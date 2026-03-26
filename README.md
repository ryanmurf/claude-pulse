# claude-pulse

Usage monitoring channel plugin for Claude Code.

Polls the Claude CLI to track subscription usage across multiple profiles and pushes threshold alerts directly into your Claude Code session via [Channels](https://docs.anthropic.com/en/docs/claude-code/channels).

## What it does

- Periodically polls `claude` CLI to capture rate-limit data (5-hour and 7-day windows)
- Stores usage history in a local SQLite database
- Fires alert notifications when usage crosses configurable thresholds
- Delivers alerts as channel events inside your active Claude Code session
- Supports multiple Claude profiles (e.g., work and personal subscriptions)

## How it works

```
                      ┌──────────────────────┐
                      │   Claude Code (IDE)   │
                      │                       │
                      │  ┌─────────────────┐  │
                      │  │ MCP Client      │  │
                      │  │ (stdio)         │  │
                      │  └────────┬────────┘  │
                      └───────────┼───────────┘
                                  │ stdin/stdout
                      ┌───────────┼───────────┐
                      │  claude-pulse (MCP)    │
                      │                        │
                      │  ┌──────┐  ┌────────┐  │
                      │  │Poller│  │ Store  │  │
                      │  │Timer │──│(SQLite)│  │
                      │  └──┬───┘  └────────┘  │
                      │     │                   │
                      │     │  ┌────────────┐   │
                      │     └──│  Alerts    │   │
                      │        │  Engine    │   │
                      │        └────────────┘   │
                      └────────────┼────────────┘
                                   │ execFile
                        ┌──────────┴──────────┐
                        │   claude CLI        │
                        │  (per profile with  │
                        │  CLAUDE_CONFIG_DIR)  │
                        └─────────────────────┘
```

1. Background pollers invoke `claude -p "say ok" --output-format json` for each profile at configurable intervals
2. Rate-limit data from the CLI response is parsed and stored in SQLite
3. The alert engine evaluates enabled subscriptions against the latest snapshot
4. When a threshold is crossed, a channel notification is pushed into your Claude Code session

## Prerequisites

- **Node.js 22+** (uses `node:sqlite` built-in module)
- **Claude Code v2.1.80+** (channel plugin support)

## Installation

```bash
git clone https://github.com/ryanmurf/claude-pulse.git
cd claude-pulse
npm install
npm run build
```

## Configuration

Add claude-pulse to your MCP configuration file (`.mcp.json` in your project root or `~/.claude/mcp.json` globally):

```json
{
  "mcpServers": {
    "claude-pulse": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/claude-pulse/dist/index.js"]
    }
  }
}
```

Then start Claude Code with the channels flag:

```bash
claude --channels
# or, for development channels:
claude --dangerously-load-development-channels
```

## Available MCP tools

| Tool | Description |
|---|---|
| `get_usage` | Get current usage for a profile or all profiles |
| `get_history` | View usage trends over a time window |
| `list_profiles` | List all configured profiles and polling intervals |
| `add_profile` | Add a new monitored profile |
| `remove_profile` | Remove a profile and stop its poller |
| `set_poll_interval` | Change how often a profile is polled (minutes) |
| `poll_now` | Immediately poll a profile for fresh data |
| `subscribe_alert` | Create a threshold or auth-failure alert |
| `unsubscribe_alert` | Remove an alert subscription |
| `list_alert_subscriptions` | View all configured alert subscriptions |
| `get_triggered_alerts` | Review past alert events |
| `acknowledge_alerts` | Mark alert events as handled |
| `reply` | Acknowledge an alert and log a response message |

## Multi-profile support

claude-pulse monitors multiple Claude subscriptions simultaneously. Each profile points to a different `CLAUDE_CONFIG_DIR`:

```
Default profiles:
  claude-hd  -> ~/.claude-hd   (5-min poll interval)
  claude-max -> ~/.claude-max   (5-min poll interval)
```

Add custom profiles at runtime:

```
Use the add_profile tool with name="work", config_dir="~/.claude-work"
```

## Alert subscriptions

Create alert subscriptions to get notified when usage crosses a threshold:

- **five_hour_threshold** -- fires when the 5-hour usage window exceeds a percentage
- **seven_day_threshold** -- fires when the 7-day usage window exceeds a percentage
- **auth_failure** -- fires when a poll returns null values (authentication problem)

Each subscription has a configurable cooldown period (default 30 minutes) to prevent alert floods.

## Channel notifications

When an alert fires, claude-pulse pushes a channel event into your Claude Code session:

```xml
<channel source="claude-pulse" alert_type="five_hour_threshold" profile="claude-hd"
         current_value="92.5" threshold="90" resets_at="2026-03-25T18:00:00Z">
  Usage alert: claude-hd 5-hour window at 92.5% (threshold: 90%)
</channel>
```

Claude Code sees this event and can take action -- notify you via Slack, adjust behavior to conserve usage, or acknowledge the alert.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Data storage

All data is stored locally in `~/.claude-pulse/usage.db` (SQLite). No data is sent to external services.

## License

[Apache License 2.0](LICENSE)

Copyright 2026 Ryan Murphy
