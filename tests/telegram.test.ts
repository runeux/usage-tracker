import { describe, expect, test } from "bun:test";
import { BotError } from "grammy";
import { CodexAuth } from "../src/auth";
import { OWNER_ID } from "../src/config";
import { reconcile } from "../src/detect";
import { DeviceLogin } from "../src/login";
import { Store } from "../src/store";
import { createTelegram } from "../src/telegram";

class CapturedRequest extends Error {}

function setup() {
  const store = new Store(":memory:");
  const auth = new CodexAuth("/unused");
  const login = new DeviceLogin("/unused");
  const { bot } = createTelegram(
    "123456:fake-test-token",
    store,
    login,
    auth,
    () => {},
  );
  bot.botInfo = {
    id: 123456,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const messages: string[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "sendMessage" && "text" in payload)
      messages.push(payload.text);
    throw new CapturedRequest();
  });
  const update = async (text: string, from = OWNER_ID, group = false) => {
    try {
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: group
            ? { id: -1000, type: "group", title: "test" }
            : { id: from, type: "private", first_name: "test" },
          from: { id: from, is_bot: false, first_name: "test" },
          text,
          ...(text.startsWith("/")
            ? {
                entities: [
                  {
                    type: "bot_command" as const,
                    offset: 0,
                    length: text.length,
                  },
                ],
              }
            : {}),
        },
      });
    } catch (error) {
      if (
        !(error instanceof BotError) ||
        !(error.error instanceof CapturedRequest)
      )
        throw error;
    }
  };
  return { store, messages, update };
}

describe("telegram handlers", () => {
  test("ignores other users and group chats", async () => {
    const { store, messages, update } = setup();
    await update("/usage", 1);
    await update("/usage", OWNER_ID, true);
    expect(messages).toEqual([]);
    store.close();
  });
  test("usage and my resets buttons read the saved snapshot", async () => {
    const { store, messages, update } = setup();
    const now = Date.now() / 1000;
    const state = reconcile(null, {
      accountId: "test",
      checkedAt: now,
      weekly: { remaining: 68, resetsAt: null },
      fiveHour: { remaining: 100, resetsAt: null },
      credits: [
        {
          id: "credit",
          status: "available",
          title: "Full reset",
          grantedAt: now,
          expiresAt: now + 1000,
        },
      ],
    }).state;
    store.commit(state, [], []);
    await update("usage");
    await update("my resets");
    expect(messages[0]).toBe("<b>Weekly</b>: 68%\n<b>5h</b>: 100%");
    expect(messages[1]).toContain("Full reset — ");
    expect(messages[1]).toContain("UTC+5");
    store.close();
  });
});
