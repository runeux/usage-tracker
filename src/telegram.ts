import { Bot, type Context, GrammyError, Keyboard } from "grammy";
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
          error.description.includes("message to delete not found")
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
  const replyUsage = async (ctx: Context) => {
    try {
      await dashboard.replace(readNow);
    } catch (error) {
      if (
        error instanceof GrammyError &&
        error.description.includes("message can't be deleted")
      ) {
        await ctx.reply(
          "Telegram не разрешил удалить предыдущий dashboard. удали его вручную и снова нажми usage.",
          { reply_markup: keyboard },
        );
        return;
      }
      throw error;
    }
  };
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
      `проверка usage: ${state ? formatDate(state.snapshot.checkedAt) : "нет данных"}\nпроверка resets: ${state?.creditsCheckedAt ? formatDate(state.creditsCheckedAt) : "нет данных"}\nдоставка: ${deliveries || "очередь пуста"}\nuncertain — доставка не подтверждена; автоматический повтор отключён для защиты от дублей.`,
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
          success
            ? "✅ вход выполнен; обновляю данные Codex."
            : "вход не завершён. можно повторить /login.",
        );
      });
      await ctx.reply(
        `отдельный вход для бота на vps:\nhttps://auth.openai.com/codex/device\n\nкод: <code>${code}</code>\nдействует до 15 минут.`,
        { parse_mode: "HTML" },
      );
    } catch {
      await ctx.reply(
        "не удалось начать вход или вход уже ожидает подтверждения. попробуй позже.",
      );
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
