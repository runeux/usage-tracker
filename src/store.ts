import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { escapeHtml } from "./messages";
import {
  type Announcement,
  type Event,
  type MonitorState,
  monitorStateSchema,
  type WorkspaceMessage,
} from "./model";

export type Delivery = {
  event_id: string;
  channel: string;
  text: string;
  attempts: number;
};
const healthSchema = z.object({
  since: z.number(),
  failures: z.number().int(),
  alerted: z.boolean(),
});
type Health = z.infer<typeof healthSchema>;

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        retry_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL,
        PRIMARY KEY (event_id, channel)
      );
      CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS workspace_messages (id TEXT PRIMARY KEY);
    `);
    this.db.run(
      "UPDATE outbox SET status = 'uncertain' WHERE status = 'sending'",
    );
    if (this.get("started_at") === null)
      this.set("started_at", String(Date.now() / 1000));
  }

  get(key: string): string | null {
    return (
      this.db
        .query<{ value: string }, [string]>(
          "SELECT value FROM meta WHERE key = ?",
        )
        .get(key)?.value ?? null
    );
  }

  set(key: string, value: string): void {
    this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  load(): MonitorState | null {
    const raw = this.get("monitor");
    return raw === null ? null : monitorStateSchema.parse(JSON.parse(raw));
  }

  private enqueue(events: Event[], channels: string[], now: number): void {
    for (const event of events)
      for (const channel of channels) {
        this.db.run(
          "INSERT OR IGNORE INTO outbox (event_id, channel, kind, text, created_at) VALUES (?, ?, ?, ?, ?)",
          [event.id, channel, event.kind, event.text, now],
        );
      }
  }

  commit(state: MonitorState, events: Event[], channels: string[]): void {
    this.db.transaction(() => {
      this.set("monitor", JSON.stringify(state));
      this.enqueue(events, channels, state.snapshot.checkedAt);
    })();
  }

  addEvents(events: Event[], channels: string[], now: number): void {
    this.db.transaction(() => this.enqueue(events, channels, now))();
  }

  recordAnnouncements(
    posts: Announcement[],
    channels: string[],
    now: number,
  ): void {
    const startedAt = Number(this.get("started_at"));
    this.db.transaction(() => {
      for (const post of [...posts].sort((a, b) =>
        a.postedAt.localeCompare(b.postedAt),
      )) {
        const result = this.db.run(
          "INSERT OR IGNORE INTO announcements (id) VALUES (?)",
          [post.postId],
        );
        if (
          result.changes === 0 ||
          Date.parse(post.postedAt) / 1000 < startedAt
        )
          continue;
        this.enqueue(
          [
            {
              id: `announcement:${post.postId}`,
              kind: "announcement",
              text: `📣 <b>Codex Team: объявление о reset</b>\nтип по классификации источника: ${post.resetType ?? "не указан"}.\nэто объявление, а не подтверждение сброса твоего аккаунта.\n<a href="${escapeHtml(post.url)}">публикация Codex Team</a> · <a href="https://tokenusage.dev/resets">данные: tokenusage.dev</a>`,
            },
          ],
          channels,
          now,
        );
      }
    })();
  }

  recordWorkspaceMessages(
    messages: WorkspaceMessage[],
    channels: string[],
    now: number,
  ): void {
    const initialized = this.get("workspace_initialized") !== null;
    const startedAt = Number(this.get("started_at"));
    this.db.transaction(() => {
      for (const message of messages) {
        const result = this.db.run(
          "INSERT OR IGNORE INTO workspace_messages (id) VALUES (?)",
          [message.messageId],
        );
        if (result.changes === 0 || message.archivedAt !== null) continue;
        if (
          !initialized &&
          (message.createdAt === null || message.createdAt < startedAt)
        )
          continue;
        const characters = Array.from(message.messageBody);
        const events: Event[] = [];
        for (let offset = 0; offset < characters.length; offset += 500) {
          events.push({
            id: `workspace:${message.messageId}:${offset}`,
            kind: "workspace-announcement",
            text: `📣 <b>Codex: сообщение аккаунта</b>\n${escapeHtml(characters.slice(offset, offset + 500).join(""))}`,
          });
        }
        this.enqueue(events, channels, now);
      }
      this.set("workspace_initialized", "1");
    })();
  }

  health(
    source: string,
    ok: boolean,
    channels: string[],
    now: number,
    options: { afterFailures?: number; failureText?: string } = {},
  ): void {
    const key = `health:${source}`;
    const raw = this.get(key);
    // this value is generated exclusively by this method, rather than read from an upstream api.
    const previous = raw === null ? null : healthSchema.parse(JSON.parse(raw));
    this.db.transaction(() => {
      if (ok) {
        if (previous?.alerted)
          this.enqueue(
            [
              {
                id: `health:recovered:${source}:${previous.since}`,
                kind: "health",
                text: `✅ источник <b>${escapeHtml(source)}</b> снова доступен.`,
              },
            ],
            channels,
            now,
          );
        this.db.run("DELETE FROM meta WHERE key = ?", [key]);
        return;
      }
      const health: Health = {
        since: previous?.since ?? now,
        failures: (previous?.failures ?? 0) + 1,
        alerted: previous?.alerted ?? false,
      };
      if (health.failures >= (options.afterFailures ?? 3) && !health.alerted) {
        health.alerted = true;
        this.enqueue(
          [
            {
              id: `health:failed:${source}:${health.since}`,
              kind: "health",
              text:
                options.failureText ??
                `⚠️ источник <b>${escapeHtml(source)}</b> недоступен уже три проверки.\nданные могут быть устаревшими; повторные проверки продолжаются.\nесли требуется вход: <code>/login</code>.`,
            },
          ],
          channels,
          now,
        );
      }
      this.set(key, JSON.stringify(health));
    })();
  }

  pending(now: number): Delivery[] {
    return this.db
      .query<Delivery, [number]>(
        "SELECT event_id, channel, text, attempts FROM outbox WHERE status = 'pending' AND retry_at <= ? ORDER BY created_at, rowid LIMIT 20",
      )
      .all(now);
  }

  mark(
    delivery: Delivery,
    status: "sending" | "sent" | "uncertain" | "failed",
  ): void {
    this.db.run(
      "UPDATE outbox SET status = ?, attempts = attempts + ? WHERE event_id = ? AND channel = ?",
      [
        status,
        status === "sending" ? 1 : 0,
        delivery.event_id,
        delivery.channel,
      ],
    );
  }

  retry(delivery: Delivery, at: number): void {
    this.db.run(
      "UPDATE outbox SET status = 'pending', retry_at = ? WHERE event_id = ? AND channel = ?",
      [at, delivery.event_id, delivery.channel],
    );
  }

  deliveryCounts(): { status: string; count: number }[] {
    return this.db
      .query<{ status: string; count: number }, []>(
        "SELECT status, count(*) AS count FROM outbox GROUP BY status",
      )
      .all();
  }

  close(): void {
    this.db.close();
  }
}
