import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CodexAuth, CodexAuthError } from "./auth";
import { loadConfig, POLL_SECONDS } from "./config";
import { deliverPending } from "./delivery";
import { nextPollAt, reconcile } from "./detect";
import { DeviceLogin } from "./login";
import { CodexProvider, readAnnouncements } from "./provider";
import { Store } from "./store";
import { createTelegram } from "./telegram";

process.umask(0o077);
const config = loadConfig();
mkdirSync(config.codexHome, { recursive: true, mode: 0o700 });
const store = new Store(join(config.dataDir, "state.sqlite"));
const auth = new CodexAuth(config.codexHome);
const login = new DeviceLogin(config.codexHome);
const provider = new CodexProvider(auth);
let stop = false;
let nextUsage = 0;
let nextAnnouncements = 0;
let nextDelivery = 0;
let nextWorkspace = 0;
let nextDashboard = 0;
let usagePoll: Promise<void> | null = null;
const { bot, channel, dashboard } = createTelegram(
  config.token,
  store,
  login,
  auth,
  () => {
    nextUsage = 0;
  },
  pollUsage,
);
const channels = [channel];
const channelIds = channels.map((item) => item.id);

function pollUsage(): Promise<void> {
  usagePoll ??= checkUsage().finally(() => {
    usagePoll = null;
  });
  return usagePoll;
}

async function checkUsage(): Promise<void> {
  try {
    const { snapshot, creditsError } = await provider.read();
    const { state, events } = reconcile(store.load(), snapshot);
    store.commit(state, events, channelIds);
    store.health("codex usage / OAuth", true, channelIds, snapshot.checkedAt);
    store.health("авторизация Codex", true, channelIds, snapshot.checkedAt);
    store.health(
      "banked resets",
      !creditsError,
      channelIds,
      snapshot.checkedAt,
    );
    nextUsage = nextPollAt(state, snapshot.checkedAt, snapshot.checkedAt);
    console.log(
      JSON.stringify({
        event: "usage_checked",
        creditsOk: !creditsError,
        events: events.map((item) => item.kind),
        nextCheckAt: nextUsage,
      }),
    );
  } catch (error) {
    const now = Date.now() / 1000;
    if (error instanceof CodexAuthError) {
      store.health("авторизация Codex", false, channelIds, now, {
        afterFailures: 1,
        failureText:
          "⚠️ <b>проблема с авторизацией Codex</b>\nне удалось проверить или обновить сессию. данные usage и resets могут быть устаревшими.\nпродолжаю попытки восстановления; для повторного входа отправь <code>/login</code>.",
      });
    } else {
      store.health("codex usage / OAuth", false, channelIds, now);
    }
    nextUsage = now + 60;
    console.error("codex usage check failed; retrying in 60 seconds");
  }
}

async function pollAnnouncements(): Promise<void> {
  const now = Date.now() / 1000;
  try {
    store.recordAnnouncements(await readAnnouncements(), channelIds, now);
    store.health("tokenusage.dev", true, channelIds, now);
    console.log(JSON.stringify({ event: "announcements_checked" }));
  } catch {
    store.health("tokenusage.dev", false, channelIds, now);
    console.error("announcement check failed");
  }
  nextAnnouncements = now + POLL_SECONDS;
}

async function pollWorkspace(): Promise<void> {
  const now = Date.now() / 1000;
  try {
    const result = await auth.workspaceMessages();
    if (result.featureEnabled)
      store.recordWorkspaceMessages(result.messages, channelIds, now);
    store.health("codex announcements", true, channelIds, now);
    console.log(
      JSON.stringify({
        event: "workspace_messages_checked",
        enabled: result.featureEnabled,
      }),
    );
  } catch {
    store.health("codex announcements", false, channelIds, now);
    console.error("codex announcement check failed");
  }
  nextWorkspace = now + POLL_SECONDS;
}

async function shutdown(): Promise<void> {
  if (stop) return;
  stop = true;
  auth.close();
  login.close();
  if (bot.isRunning()) await bot.stop();
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

try {
  await bot.init();
  await bot.api.setMyCommands([
    { command: "start", description: "открыть меню" },
    { command: "usage", description: "оставшийся weekly / 5h лимит" },
    { command: "status", description: "состояние мониторинга" },
    { command: "login", description: "повторный вход в Codex" },
  ]);
  const polling = bot.start({
    allowed_updates: ["message"],
    onStart: () => console.log("telegram polling started"),
  });
  void polling.catch(() => {
    console.error("telegram polling stopped unexpectedly");
    process.exitCode = 1;
    void shutdown();
  });
  store.addEvents(
    [
      {
        id: "monitor:installed",
        kind: "startup",
        text: "✅ <b>usage tracker запущен на vps</b>\nпроверка каждую минуту; у weekly deadline — дополнительная проверка.\nкнопка usage открывает live dashboard. проценты — оставшийся лимит; время — UTC+5.",
      },
    ],
    channelIds,
    Date.now() / 1000,
  );
  while (!stop) {
    const now = Date.now() / 1000;
    const tasks: Promise<void>[] = [];
    if (now >= nextUsage) tasks.push(pollUsage());
    if (now >= nextAnnouncements) tasks.push(pollAnnouncements());
    if (now >= nextWorkspace) tasks.push(pollWorkspace());
    await Promise.all(tasks);
    if (!stop && Date.now() / 1000 >= nextDashboard) {
      try {
        await dashboard.refresh();
      } catch {
        console.error("dashboard update failed; retrying next minute");
      }
      nextDashboard = Date.now() / 1000 + POLL_SECONDS;
    }
    if (Date.now() / 1000 >= nextDelivery && !stop) {
      await deliverPending(store, channels, Date.now() / 1000);
      nextDelivery = Date.now() / 1000 + 5;
    }
    if (!stop) await Bun.sleep(1000);
  }
  await polling;
} finally {
  auth.close();
  login.close();
  store.close();
}
