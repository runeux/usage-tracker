# setup & deployment

[← readme](../README.md)

## local setup

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

## vps deployment

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

Authenticate once as the service user. Keep the login command running over SSH while you open its verification link and enter the one-time code on your own device. The CLI saves the session under the configured `CODEX_HOME`. If the code expires, run the login command again.

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

## development

```sh
bun run check      # biome lint and formatting
bun run typecheck  # strict typescript
bun test           # detector, persistence, delivery, contracts, telegram handlers
bun run build      # build/index.js, external runtime dependencies
bun run verify     # all of the above
```
