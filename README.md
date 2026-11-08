<h1 align="center">usage tracker</h1>

<p align="center">codex usage and reset alerts, delivered to telegram</p>

<p align="center">
  <a href="docs/behavior.md">behavior</a> ·
  <a href="docs/deployment.md">deployment</a>
</p>

## dashboard

open the bot in telegram and press **usage** to see what’s left of your weekly and 5-hour limits, when they reset, and when your banked resets expire. the bot checks once a minute and updates the same message.

```text
weekly: 21% – nov 5, 11:05 pm
5-hour: 100% – 7:16 pm

weekly reset – in 3 hours (nov 5, 11:47 pm)
weekly reset – in 2 days (nov 7)
weekly reset – in 3 weeks (nov 26)
```

percentages show **remaining allowance**. dates and times use **UTC+5**.

## alerts

| event           | when                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| weekly reset    | a tracked deadline passes or an early reset is confirmed                    |
| 5-hour reset    | the window resets after the bot last saw less than 30% remaining            |
| banked reset    | a credit arrives, is redeemed, or expires                                   |
| expiry reminder | 3 days, 1 day, and 2 hours before a credit expires                          |
| announcement    | a new reset post appears on [tokenusage.dev](https://tokenusage.dev/resets) |
| login required  | codex authorization fails, with a follow-up when access returns             |

the bot keeps its state and pending notifications across restarts. [detection rules and delivery limits](docs/behavior.md)

## telegram commands

| button or command           | action                                    |
| --------------------------- | ----------------------------------------- |
| `usage`, `/usage`, `/start` | open or refresh the dashboard             |
| `/status`                   | check sources and notification delivery   |
| `/login`                    | sign in to codex again with a device code |

## run your own bot

you’ll need **bun 1.4+**, a telegram bot token, and a separate codex login for the bot. set `OWNER_ID` to your telegram user id in [`src/config.ts`](src/config.ts). the bot only responds in that user’s private chat.

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

`bun run login` starts device-code sign-in through the official codex cli. `bun run doctor` checks access to the undocumented, read-only endpoints for usage and banked resets.

for systemd and persistent storage, see the [deployment guide](docs/deployment.md).

## development

bun · typescript · grammy · zod · sqlite · biome

```sh
bun run dev       # watch mode
bun run verify    # lint, types, tests, build
```

## license

[mit license](LICENSE) · [third-party notices](THIRD_PARTY_NOTICES.md)
