import { Bot, type Context, GrammyError, Keyboard } from "grammy";
import type { CodexAuth } from "./auth";
import { OWNER_ID } from "./config";
import { type Channel, RejectedDelivery } from "./delivery";
import type { DeviceLogin } from "./login";
import { formatDate, resetsMessage, usageMessage } from "./messages";
import type { Store } from "./store";

export function createTelegram(
  token: string,
  store: Store,
  login: DeviceLogin,
  auth: CodexAuth,
  refreshSoon: () => void,
): { bot: Bot; channel: Channel } {
  const bot = new Bot(token, { client: { timeoutSeconds: 35 } });
  const keyboard = new Keyboard()
    .text("usage")
    .text("my resets")
    .resized()
    .persistent();

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
    await ctx.reply(
      usageMessage(store.load()?.snapshot ?? null, Date.now() / 1000),
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  };
  const replyResets = async (ctx: Context) => {
    const state = store.load();
    if (!state || state.creditsCheckedAt === null) {
      await ctx.reply(
        "список resets ещё не получен. бот повторит проверку автоматически.",
        { reply_markup: keyboard },
      );
      return;
    }
    for (const text of resetsMessage(
      state.snapshot.credits ?? Object.values(state.knownCredits),
      state.creditsCheckedAt,
      Date.now() / 1000,
    )) {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
  };
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "слежу за Codex каждые 5 минут. проценты показывают оставшийся лимит. время — UTC+5.\n/status — состояние, /login — повторный вход.",
      { reply_markup: keyboard },
    );
    await replyUsage(ctx);
  });
  bot.command("usage", replyUsage);
  bot.hears(/^usage$/i, replyUsage);
  bot.command("resets", replyResets);
  bot.hears(/^my resets$/i, replyResets);
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
  return { bot, channel };
}
