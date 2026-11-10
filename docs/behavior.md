# behavior

[← readme](../README.md)

## behavior

- Polls account usage, reset credits, and announcements every minute.
- Adds a poll five seconds after a known reset deadline. A successful request normally delivers the weekly notification within a minute; network outages can delay confirmation.
- Notifies about a scheduled **5h reset only when the last observed remaining allowance was strictly below 30%**. Exactly 30% does not qualify.
- Always notifies when a previously observed **weekly deadline** is crossed, including a completely unused window. The notification is `<b>reset</b>: weekly`; scheduled and confirmed instant resets use the same wording. Five-hour notifications use `<b>reset</b>: 5-hour`.
- Detects an **instant reset** when the weekly deadline changes by more than two minutes before its scheduled end and weekly allowance becomes 100%. Confirms the new deadline with another read after 30 seconds. An observed banked redemption, missing inventory, or unavailable credit data suppresses this inference. This identifies an account-level signature; it cannot prove which other accounts received a global reset.
- Tracks newly available banked credits by their backend ID and notifies with `<b>new banked reset</b>: weekly – Nov 5, 2:39 PM`, using the credit expiry date and local time. Banked redemption uses `<b>reset</b>: weekly`. Expiry dates remain available through the `usage` dashboard in **UTC+5**. Also reports explicit redemption, expiry, and expiry reminders at three days, one day, and two hours before expiration. Dates use UTC+5 throughout, without a repeated timezone suffix. Only the most urgent crossed reminder is sent after an outage; already-passed thresholds are not replayed on deployment.
- Does not infer redemption merely because a credit disappears from a response. If a known expiry is crossed and the credit disappears, reports the deadline ending without claiming whether it was used first. Partial or invalid responses do not erase saved inventory.
- Separately forwards new reset announcements from [tokenusage.dev](https://tokenusage.dev/resets), with source attribution and the original publication link. An announcement is never presented as proof of an account reset.
- Reads other account announcements through the official Codex app-server workspace-message interface, when enabled for the account. This and tokenusage.dev are bounded sources, not a complete archive of the Codex team's social posts.
- Establishes a quiet baseline on first run. Existing credits and historical announcements are not reported as newly received.

Percentages always mean **remaining allowance**. Usage consumed between two polls is not observable; the 5h threshold uses the last successful observation before the reset.

## telegram

The owner is hardcoded in `src/config.ts`. Only that user's private chat is accepted. Group chats and other users are ignored.

| Button or command           | Result                                                  |
| --------------------------- | ------------------------------------------------------- |
| `usage`, `/usage`, `/start` | Fresh combined usage and banked-reset dashboard         |
| `/status`                   | Last successful checks and notification delivery state  |
| `/login`                    | Start a new official Codex device-code login on the VPS |

The keyboard has one `usage` button. Pressing it reads current Codex data, sends a new combined message, and saves its ID. Minute updates edit only that ID; restarts resume it. The bot then tries to delete the previous dashboard. If Telegram refuses to delete it, the old message stays in the chat and stops updating. Unchanged text is not edited. A manually deleted dashboard is cleared and is recreated only on another button press.

The persistent keyboard is configured in a temporary message that is immediately deleted. The dashboard itself has no reply keyboard markup, because Telegram rejects edits to messages carrying that markup. Long reset lists are bounded by Telegram's single-message limit, with an explicit omission notice.

Example:

```text
weekly: 21% – Nov 5, 11:05 PM
5-hour: 100% – 7:16 PM

weekly reset – in 3 hours (Nov 5, 11:47 PM)
weekly reset – in 2 days (Nov 7)
weekly reset – in 3 weeks (Nov 26)
```

Weekly deadlines and banked expiry dates include a time only when less than 24 hours remain. At exactly 24 hours they show only the date. The 5-hour deadline always shows only the time. Relative banked expiry uses whole weeks, days, hours, or minutes, with singular/plural forms. Old cached data is labelled when a successful read is more than six minutes old. Missing initial data is explicitly reported.

## sources and authentication

The read-only `/wham/usage` and `/wham/rate-limit-reset-credits` contracts and normalization approach are adapted from [AyalX/codex-reset-tracker](https://github.com/AyalX/codex-reset-tracker/tree/f42c407e8812ee06cbbfe926d4e16592ed6a3d16). The small adapter is TypeScript rather than a Python subprocess; this preserves original credit IDs and terminal statuses needed for deduplication. Attribution is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The [official Codex CLI](https://github.com/openai/codex) owns OAuth login, token rotation, and credential persistence. The bot communicates with its local app-server over stdio. It requests a proactive refresh every 45 minutes and retries once with refreshed credentials after a usage API 401. It does not implement an independent OAuth refresh flow and never consumes a reset credit or starts a model turn.

Use a **separate login** for the bot, rather than sharing a refresh token with another active client. [Official headless-login documentation](https://learn.chatgpt.com/docs/auth?surface=cli) describes device authorization and credential storage. If device authorization is disabled, enable it in ChatGPT Security Settings before logging in. An account logout or revoked session may require `/login`. A failed CLI credential check/refresh or a backend 401 that persists after refreshing creates an immediate authorization alert with `/login` instructions. This includes authorization failures while reading banked credits. The incident and its delivery are persisted, so repeated failures and restarts do not duplicate the alert. A successful account read sends one recovery notification. Other source failures retain the three-check outage threshold.

The authenticated allowance endpoints are undocumented backend APIs and may change. Runtime validation rejects malformed data rather than interpreting it as a reset. The public announcement contract is documented at [tokenusage.dev/developers](https://tokenusage.dev/developers).

## delivery guarantees

Snapshots and resulting events are committed in a single SQLite transaction. Each event has a stable ID, and each `(event ID, channel)` has one durable outbox record. Restarts retain baselines, announcements, outage incidents, and delivery status. A future channel implements `Channel` in `src/delivery.ts`; multiple channels can share the same events with independent delivery records.

Telegram has no idempotency key for `sendMessage`, so exactly-once delivery across a lost network response is impossible. This bot prioritizes avoiding duplicates:

- Successful messages are never retried.
- Explicit rate-limit and server rejections are retried; other explicit rejections are marked failed.
- An ambiguous timeout, or a crash after submission but before acknowledgement, becomes `uncertain` and is not automatically resent. `/status` exposes these deliveries. In this rare case a notification may be lost.

This tradeoff applies to automatic notifications. Direct command replies are ordinary Telegram request/response messages.
