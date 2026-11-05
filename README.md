# Codex Usage Tracker

A personal Telegram bot that watches Codex allowance, banked resets, and reset announcements on a VPS. Built with Bun, TypeScript, grammY, Biome, Zod, and SQLite.

## Behavior

- Polls account usage, reset credits, and announcements every five minutes.
- Adds a poll five seconds after a known reset deadline. A successful request normally delivers the weekly notification within a minute; network outages can delay confirmation.
- Notifies about a scheduled **5h reset only when the last observed remaining allowance was strictly below 30%**. Exactly 30% does not qualify.
- Always notifies when a previously observed **weekly deadline** is crossed, including a completely unused window. The message reports the scheduled window ending; it does not invent a freshly observed 100% allowance.
- Detects an **instant reset** when the weekly deadline changes by more than two minutes before its scheduled end and weekly allowance becomes 100%. Confirms the new deadline with another read after 30 seconds. An observed banked redemption, missing inventory, or unavailable credit data suppresses this inference. This identifies an account-level signature; it cannot prove which other accounts received a global reset.
- Reports newly available banked credits by their backend ID, with their expiry in **UTC+5**. Also reports explicit redemption, expiry, and expiry reminders at three days, one day, and two hours before expiration. Dates use UTC+5 throughout, without a repeated timezone suffix. Only the most urgent crossed reminder is sent after an outage; already-passed thresholds are not replayed on deployment.
- Does not infer redemption merely because a credit disappears from a response. If a known expiry is crossed and the credit disappears, reports the deadline ending without claiming whether it was used first. Partial or invalid responses do not erase saved inventory.
- Separately forwards new reset announcements from [tokenusage.dev](https://tokenusage.dev/resets), with source attribution and the original publication link. An announcement is never presented as proof of an account reset.
- Reads other account announcements through the official Codex app-server workspace-message interface, when enabled for the account. This and tokenusage.dev are bounded sources, not a complete archive of the Codex team's social posts.
- Establishes a quiet baseline on first run. Existing credits and historical announcements are not reported as newly received.

Percentages always mean **remaining allowance**. Usage consumed between two polls is not observable; the 5h threshold uses the last successful observation before the reset.

## Telegram

The owner is hardcoded in `src/config.ts`. Only that user's private chat is accepted. Group chats and other users are ignored.

| Button or command      | Result                                                  |
| ---------------------- | ------------------------------------------------------- |
| `usage`, `/usage`      | Latest saved remaining weekly and 5h allowance          |
| `my resets`, `/resets` | Available banked resets, earliest expiry first          |
| `/start`               | Persistent keyboard and usage                           |
| `/status`              | Last successful checks and notification delivery state  |
| `/login`               | Start a new official Codex device-code login on the VPS |

Example:

```text
Weekly: 21% – Nov 5, 11:05 PM
5-hour: 100% – 7:16 PM

・ Full reset – in 3 hours (Nov 5, 11:47 PM)
・ Full reset – in 2 days (Nov 7)
・ Full reset – in 3 weeks (Nov 26)
```

Weekly deadlines and banked expiry dates include a time only when less than 24 hours remain. At exactly 24 hours they show only the date. The 5-hour deadline always shows only the time. Relative banked expiry uses whole weeks, days, hours, or minutes, with singular/plural forms. Old cached data is labelled when a successful read is more than six minutes old. Missing initial data is explicitly reported.

## Sources and authentication

The read-only `/wham/usage` and `/wham/rate-limit-reset-credits` contracts and normalization approach are adapted from [AyalX/codex-reset-tracker](https://github.com/AyalX/codex-reset-tracker/tree/f42c407e8812ee06cbbfe926d4e16592ed6a3d16). The small adapter is TypeScript rather than a Python subprocess; this preserves original credit IDs and terminal statuses needed for deduplication. Attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The [official Codex CLI](https://github.com/openai/codex) owns OAuth login, token rotation, and credential persistence. The bot communicates with its local app-server over stdio. It requests a proactive refresh every 45 minutes and retries once with refreshed credentials after a usage API 401. It does not implement an independent OAuth refresh flow and never consumes a reset credit or starts a model turn.

Use a **separate login** for the bot, rather than sharing a refresh token with another active client. [Official headless-login documentation](https://learn.chatgpt.com/docs/auth?surface=cli) describes device authorization and credential storage. If device authorization is disabled, enable it in ChatGPT Security Settings before logging in. An account logout or revoked session may require `/login`. A failed CLI credential check/refresh or a backend 401 that persists after refreshing creates an immediate authorization alert with `/login` instructions. This includes authorization failures while reading banked credits. The incident and its delivery are persisted, so repeated failures and restarts do not duplicate the alert. A successful account read sends one recovery notification. Other source failures retain the three-check outage threshold.

The authenticated allowance endpoints are undocumented backend APIs and may change. Runtime validation rejects malformed data rather than interpreting it as a reset. The public announcement contract is documented at [tokenusage.dev/developers](https://tokenusage.dev/developers).

## Local setup

```sh
bun install --frozen-lockfile
cp .env.example .env
# Fill TELEGRAM_BOT_TOKEN in .env.
mkdir -p data/codex
bun run login
bun run doctor
bun run verify
bun run start
```

Bun loads `.env` for both the bot and CLI scripts. `CODEX_HOME` must point to a dedicated directory. Never run a second long-polling bot with the same Telegram token while the VPS instance is active.

Secrets, OAuth files, SQLite state, dependencies, and build output are ignored by Git. Production uses a filled `.env` on the server and a separate credential file, both mode `0600`.

## VPS deployment

The supplied systemd unit uses these paths:

| Path                                  | Purpose                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `/opt/usage-tracker`                  | Application code, dependencies, build output, `.env`    |
| `/var/lib/usage-tracker/state.sqlite` | Persistent monitor state, source IDs, incidents, outbox |
| `/var/lib/usage-tracker/codex`        | Dedicated Codex login and auth state                    |

Create a system user named `usage-tracker`, give it ownership of these directories, install Bun in `/usr/local/bin/bun`, and install dependencies from the lockfile. Production `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=<your token>
DATA_DIR=/var/lib/usage-tracker
CODEX_HOME=/var/lib/usage-tracker/codex
```

Authenticate once as the service user:

```sh
cd /opt/usage-tracker
sudo -u usage-tracker /usr/local/bin/bun run login
sudo -u usage-tracker /usr/local/bin/bun run doctor
bun run verify
sudo install -m 644 deploy/usage-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now usage-tracker
```

The service runs without root privileges, restarts after failure, and starts after a VPS reboot. No inbound port is needed. State and OAuth credentials remain outside the application directory so replacing code preserves them.

```sh
ssh aeza 'systemctl status usage-tracker --no-pager'
ssh aeza 'journalctl -u usage-tracker -n 50 --no-pager'
ssh aeza 'systemctl restart usage-tracker'
```

Before an update, run `bun run verify`, transfer the tracked source, install the frozen lockfile and rebuild on the server, then restart the service. Keep the existing production `.env` and `/var/lib/usage-tracker` intact. To back up state and credentials consistently, stop the service briefly, archive `/var/lib/usage-tracker` plus `/opt/usage-tracker/.env` to a private location, then restart it. Backups contain credentials and must not be published.

## Delivery guarantees

Snapshots and resulting events are committed in a single SQLite transaction. Each event has a stable ID, and each `(event ID, channel)` has one durable outbox record. Restarts retain baselines, announcements, outage incidents, and delivery status. A future channel implements `Channel` in `src/delivery.ts`; multiple channels can share the same events with independent delivery records.

Telegram has no idempotency key for `sendMessage`, so exactly-once delivery across a lost network response is impossible. This bot prioritizes avoiding duplicates:

- Successful messages are never retried.
- Explicit rate-limit and server rejections are retried; other explicit rejections are marked failed.
- An ambiguous timeout, or a crash after submission but before acknowledgement, becomes `uncertain` and is not automatically resent. `/status` exposes these deliveries. In this rare case a notification may be lost.

This tradeoff applies to automatic notifications. Direct command replies are ordinary Telegram request/response messages.

## Development

```sh
bun run check      # biome lint and formatting
bun run typecheck  # strict typescript
bun test           # detector, persistence, delivery, contracts, telegram handlers
bun run build      # build/index.js, external runtime dependencies
bun run verify     # all of the above
```
