import { describe, expect, test } from "bun:test";
import { BotError, GrammyError } from "grammy";
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
  store.set("dashboard_keyboard_ready", "1");
  const { bot, channel } = createTelegram(
    "123456:fake-test-token",
    store,
    login,
    auth,
    () => {},
    async () => {},
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
  const keyboards: unknown[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "sendMessage" && "text" in payload)
      messages.push(payload.text);
    if (method === "sendMessage" && "reply_markup" in payload)
      keyboards.push(payload.reply_markup);
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
  return { bot, store, messages, keyboards, update, channel };
}

describe("telegram handlers", () => {
  test("ignores other users and group chats", async () => {
    const { store, messages, update } = setup();
    await update("/usage", 1);
    await update("/usage", OWNER_ID, true);
    expect(messages).toEqual([]);
    store.close();
  });
  test("usage switches dashboards even when telegram refuses to delete the old one", async () => {
    const { bot, store, messages, update } = setup();
    store.set("dashboard", JSON.stringify({ id: 42, text: "old dashboard" }));
    const deletions: number[] = [];
    bot.api.deleteMessage = async (chatId, messageId) => {
      deletions.push(messageId);
      throw new GrammyError(
        "telegram rejected deletion",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: message can't be deleted",
        },
        "deleteMessage",
        { chat_id: chatId, message_id: messageId },
      );
    };
    bot.api.sendMessage = async (_chatId, text) => {
      messages.push(text);
      return {
        message_id: 43,
        date: 0,
        chat: { id: OWNER_ID, type: "private", first_name: "test" },
        text,
      };
    };

    await update("/usage");

    expect(messages).toHaveLength(1);
    expect(deletions).toEqual([42]);
    expect(store.get("dashboard")).toBe(
      JSON.stringify({ id: 43, text: messages[0] }),
    );
    store.close();
  });
  test("usage button sends one combined dashboard and old resets button is inactive", async () => {
    const { store, messages, keyboards, update, channel } = setup();
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
    expect(messages[0]).toStartWith(
      "<b>weekly: </b>68%\n<b>5-hour</b>: 100%\n\n<b>weekly reset</b> – in 16 minutes (",
    );
    expect(messages).toHaveLength(1);
    expect(keyboards).toEqual([]);
    await expect(channel.send("notification")).rejects.toBeInstanceOf(
      CapturedRequest,
    );
    expect(keyboards[0]).toEqual({
      keyboard: [[{ text: "usage" }]],
      resize_keyboard: true,
      is_persistent: true,
    });
    expect(messages[0]).not.toContain("UTC+5");
    store.close();
  });
});
