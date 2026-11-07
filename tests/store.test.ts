import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Channel,
  deliverPending,
  RejectedDelivery,
} from "../src/delivery";
import type { Announcement, Event } from "../src/model";
import { Store } from "../src/store";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const event: Event = { id: "test:1", kind: "test", text: "hello" };
const post: Announcement = {
  postId: "1",
  postedAt: new Date().toISOString(),
  resetType: "automatic",
  url: "https://x.com/i/status/1",
};
function databasePath() {
  const path = mkdtempSync(join(tmpdir(), "usage-tracker-test-"));
  directories.push(path);
  return join(path, "state.sqlite");
}

describe("persistent delivery", () => {
  test("event deduplication survives restarts, per channel", () => {
    const path = databasePath();
    const first = new Store(path);
    first.addEvents([event, event], ["telegram", "other"], 1);
    expect(first.pending(2)).toHaveLength(2);
    first.close();
    const second = new Store(path);
    second.addEvents([event], ["telegram"], 2);
    expect(second.pending(3)).toHaveLength(2);
    second.close();
  });
  test("successful delivery is never resent", async () => {
    const store = new Store(":memory:");
    let sends = 0;
    const channel: Channel = {
      id: "telegram",
      async send() {
        sends++;
      },
    };
    store.addEvents([event], [channel.id], 1);
    await deliverPending(store, [channel], 2);
    store.addEvents([event], [channel.id], 3);
    await deliverPending(store, [channel], 4);
    expect(sends).toBe(1);
    expect(store.deliveryCounts()).toEqual([{ status: "sent", count: 1 }]);
    store.close();
  });
  test("an ambiguous network result is not retried", async () => {
    const store = new Store(":memory:");
    let sends = 0;
    const channel: Channel = {
      id: "telegram",
      async send() {
        sends++;
        throw new Error("timeout after telegram may have accepted the message");
      },
    };
    store.addEvents([event], [channel.id], 1);
    await deliverPending(store, [channel], 2);
    await deliverPending(store, [channel], 1000);
    expect(sends).toBe(1);
    expect(store.deliveryCounts()).toEqual([{ status: "uncertain", count: 1 }]);
    store.close();
  });
  test("telegram rate limiting is retried only after retry_after", async () => {
    const store = new Store(":memory:");
    let sends = 0;
    const channel: Channel = {
      id: "telegram",
      async send() {
        if (++sends === 1) throw new RejectedDelivery(60);
      },
    };
    store.addEvents([event], [channel.id], 1);
    await deliverPending(store, [channel], 2);
    await deliverPending(store, [channel], 61);
    expect(sends).toBe(1);
    await deliverPending(store, [channel], 62);
    expect(sends).toBe(2);
    expect(store.deliveryCounts()).toEqual([{ status: "sent", count: 1 }]);
    store.close();
  });
  test("crash between submission and acknowledgement remains uncertain after restart", () => {
    const path = databasePath();
    const first = new Store(path);
    first.addEvents([event], ["telegram"], 1);
    const delivery = first.pending(2)[0];
    if (!delivery) throw new Error("expected queued delivery");
    first.mark(delivery, "sending");
    first.close();
    const second = new Store(path);
    expect(second.pending(100)).toHaveLength(0);
    expect(second.deliveryCounts()).toEqual([
      { status: "uncertain", count: 1 },
    ]);
    second.close();
  });
  test("old announcements are baselined; new posts are sent once", () => {
    const store = new Store(":memory:");
    store.set("started_at", "100");
    store.recordAnnouncements(
      [{ ...post, postedAt: new Date(99_000).toISOString() }],
      ["telegram"],
      200,
    );
    expect(store.pending(200)).toHaveLength(0);
    store.recordAnnouncements(
      [{ ...post, postId: "2", postedAt: new Date(101_000).toISOString() }],
      ["telegram"],
      200,
    );
    store.recordAnnouncements(
      [{ ...post, postId: "2", postedAt: new Date(101_000).toISOString() }],
      ["telegram"],
      300,
    );
    expect(store.pending(300)).toHaveLength(1);
    store.close();
  });
  test("repeated source errors produce one incident and one recovery", () => {
    const store = new Store(":memory:");
    for (let i = 0; i < 5; i++)
      store.health("source", false, ["telegram"], 100 + i);
    expect(store.pending(200)).toHaveLength(1);
    store.health("source", true, ["telegram"], 200);
    store.health("source", true, ["telegram"], 201);
    expect(store.pending(300)).toHaveLength(2);
    store.close();
  });
});

test("workspace announcements are baselined and deduplicated by backend id", () => {
  const store = new Store(":memory:");
  store.set("started_at", "100");
  const old = {
    messageId: "old",
    messageType: "announcement",
    messageBody: "existing",
    createdAt: 50,
    archivedAt: null,
  };
  store.recordWorkspaceMessages([old], ["telegram"], 200);
  expect(store.pending(200)).toHaveLength(0);
  const fresh = {
    ...old,
    messageId: "new",
    messageBody: "<hello>",
    createdAt: 201,
  };
  store.recordWorkspaceMessages([old, fresh], ["telegram"], 202);
  store.recordWorkspaceMessages([fresh], ["telegram"], 203);
  const pending = store.pending(204);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.text).toContain("&lt;hello&gt;");
  store.close();
});

test("auth incidents alert immediately and remain deduplicated across restarts", async () => {
  const path = databasePath();
  const first = new Store(path);
  const options = {
    afterFailures: 1,
    failureText: "authorization failed; use /login",
  };
  const sent: string[] = [];
  const channel: Channel = {
    id: "telegram",
    async send(text) {
      sent.push(text);
    },
  };
  first.health("auth", false, [channel.id], 100, options);
  expect(first.pending(100)[0]?.text).toBe(options.failureText);
  await deliverPending(first, [channel], 100);
  first.close();
  const second = new Store(path);
  second.health("auth", false, [channel.id], 200, options);
  await deliverPending(second, [channel], 200);
  expect(sent).toEqual([options.failureText]);
  second.health("auth", true, [channel.id], 300);
  second.health("auth", true, [channel.id], 301);
  await deliverPending(second, [channel], 302);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain("recovered");
  second.health("auth", false, [channel.id], 400, options);
  expect(second.pending(400)).toHaveLength(1);
  second.close();
});
