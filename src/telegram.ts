import { Bot, GrammyError, Keyboard } from "grammy";
import type { CodexAuth } from "./auth";
import { OWNER_ID } from "./config";
import { Dashboard } from "./dashboard";
import { type Channel, RejectedDelivery } from "./delivery";
import type { DeviceLogin } from "./login";
import { formatDate } from "./messages";
import type { Store } from "./store";

export function createTelegram(
  token: string,
  store: Store,
  login: DeviceLogin,
  auth: CodexAuth,
  refreshSoon: () => void,
  readNow: () => Promise<void>,
): { bot: Bot; channel: Channel; dashboard: Dashboard } {
  const bot = new Bot(token, { client: { timeoutSeconds: 35 } });
  const keyboard = new Keyboard().text("usage").resized().persistent();
  const dashboard = new Dashboard(store, {
    async send(text) {
      if (store.get("dashboard_keyboard_ready") === null) {
        const menu = await bot.api.sendMessage(OWNER_ID, "…", {
          reply_markup: keyboard,
          disable_notification: true,
        });
        await bot.api.deleteMessage(OWNER_ID, menu.message_id);
        store.set("dashboard_keyboard_ready", "1");
      }
      const message = await bot.api.sendMessage(OWNER_ID, text, {
        parse_mode: "HTML",
      });
      return message.message_id;
    },
    async edit(id, text) {
      try {
        await bot.api.editMessageText(OWNER_ID, id, text, {
          parse_mode: "HTML",
        });
        return true;
      } catch (error) {
        if (
          error instanceof GrammyError &&
          error.description.includes("message is not modified")
        )
          return true;
        if (
          error instanceof GrammyError &&
          error.description.includes("message to edit not found")
        ) {
          return false;
        }
        throw error;
      }
    },
    async remove(id) {
      try {
        await bot.api.deleteMessage(OWNER_ID, id);
      } catch (error) {
        if (
          error instanceof GrammyError &&
          (error.description.includes("message to delete not found") ||
            error.description.includes("message can't be deleted"))
        )
          return;
        throw error;
      }
    },
  });

  bot.use(async (ctx, next) => {
    if (
      ctx.from?.id !== OWNER_ID ||
      ctx.chat?.type !== "private" ||
      ctx.chat.id !== OWNER_ID
    )
      return;
    await next();
  });
  const replyUsage = () => dashboard.replace(readNow);
  bot.command("start", replyUsage);
  bot.command("usage", replyUsage);
  bot.hears(/^usage$/i, replyUsage);
  bot.command("status", async (ctx) => {
    const state = store.load();
    const deliveries = store
      .deliveryCounts()
      .map((item) => `${item.status}: ${item.count}`)
      .join(", ");
    await ctx.reply(
      `usage checked: ${state ? formatDate(state.snapshot.checkedAt) : "no data"}\nresets checked: ${state?.creditsCheckedAt ? formatDate(state.creditsCheckedAt) : "no data"}\ndelivery: ${deliveries || "empty"}`,
      { reply_markup: keyboard },
    );
  });
  bot.command("login", async (ctx) => {
    try {
      const code = await login.start(async (success) => {
        if (success) {
          auth.close();
          refreshSoon();
        }
        await bot.api.sendMessage(
          OWNER_ID,
          success ? "codex connected" : "login incomplete – /login",
        );
      });
      await ctx.reply(
        `<a href="https://auth.openai.com/codex/device">codex login</a>\ncode: <code>${code}</code> · 15 min`,
        { parse_mode: "HTML" },
      );
    } catch {
      await ctx.reply("login unavailable – try /login again");
    }
  });
  bot.catch(() => console.error("telegram handler failed"));

  const channel: Channel = {
    id: "telegram",
    async send(text) {
      try {
        await bot.api.sendMessage(OWNER_ID, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        });
      } catch (error) {
        if (error instanceof GrammyError) {
          throw new RejectedDelivery(
            error.error_code === 429
              ? (error.parameters.retry_after ?? 60)
              : error.error_code >= 500
                ? 60
                : null,
          );
        }
        throw error;
      }
    },
  };
  return { bot, channel, dashboard };
}
