<h1 align="center">usage tracker</h1>

<p align="center">codex limits. telegram alerts.</p>

<p align="center">
  <a href="docs/behavior.md">behavior</a> ·
  <a href="docs/deployment.md">deployment</a>
</p>

A personal Telegram bot for Codex usage and banked resets. One dashboard, updated every minute. Alerts when limits reset or credits are about to expire.

```text
weekly: 21% – Nov 5, 11:05 PM
5-hour: 100% – 7:16 PM

weekly reset – in 3 hours (Nov 5, 11:47 PM)
weekly reset – in 2 days (Nov 7)
weekly reset – in 3 weeks (Nov 26)
```

Percentages show **remaining allowance**. Dates use **UTC+5**.

### alerts

| Event           | When                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| Weekly reset    | A tracked deadline passes or an early reset is confirmed                    |
| 5-hour reset    | The last observed allowance was below 30%                                   |
| Banked reset    | A credit arrives, is redeemed, or expires                                   |
| Expiry reminder | 3 days, 1 day, and 2 hours before expiry                                    |
| Announcement    | A new reset post appears on [tokenusage.dev](https://tokenusage.dev/resets) |
| Login required  | Authorization fails; one recovery notice when restored                      |

State and pending notifications survive restarts in SQLite. [Detection rules and delivery limits →](docs/behavior.md)

### telegram

| Command                       | Action                                  |
| ----------------------------- | --------------------------------------- |
| `usage` · `/usage` · `/start` | Refresh the dashboard                   |
| `/status`                     | Check sources and notification delivery |
| `/login`                      | Start Codex device-code login           |

Only the owner's private chat is accepted. Set `OWNER_ID` in [`src/config.ts`](src/config.ts) before running your own instance.

### run

Requires **Bun 1.4+**, a Telegram bot token, and a separate Codex login for the bot.

```sh
bun install --frozen-lockfile
cp .env.example .env
# set TELEGRAM_BOT_TOKEN in .env
mkdir -p data/codex
bun run login
bun run doctor
bun run verify
bun run start
```

The official Codex CLI manages authentication. Usage and reset-credit reads use undocumented backend APIs. The bot never redeems credits or starts model turns.

### development

Bun · TypeScript · grammY · Zod · SQLite · Biome

```sh
bun run dev       # watch mode
bun run verify    # lint, types, tests, build
```

[Setup & systemd deployment](docs/deployment.md) · [Behavior & authentication](docs/behavior.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
