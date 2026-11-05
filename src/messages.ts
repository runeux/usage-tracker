import type { Credit, MonitorState, Snapshot, UsageWindow } from "./model";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatDate(
  seconds: number,
  style: "date" | "time" | "datetime" = "datetime",
): string {
  const date = new Date(seconds * 1000);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Yekaterinburg",
    month: "short",
    day: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Yekaterinburg",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  if (style === "date") return day;
  if (style === "time") return time;
  return `${day}, ${time}`;
}

export function creditTitle(credit: Credit): string {
  return escapeHtml(credit.title.replace(/\s*\(Weekly \+ 5 hr\)/i, ""));
}

export function creditLabel(credit: Credit): string {
  return `${creditTitle(credit)} — ${credit.expiresAt === null ? "no expiry" : formatDate(credit.expiresAt)}`;
}

export function usageMessage(snapshot: Snapshot | null, now: number): string {
  if (!snapshot)
    return "данные ещё не получены. бот повторит проверку автоматически.";

  const windowText = (
    window: UsageWindow | null,
    style: "date" | "time" | "datetime",
  ): string => {
    if (!window) return "нет данных";
    if (window.resetsAt === null) return `${Math.round(window.remaining)}%`;
    return `${Math.round(window.remaining)}% – ${formatDate(window.resetsAt, style)}`;
  };
  const weeklyStyle =
    snapshot.weekly?.resetsAt != null && snapshot.weekly.resetsAt - now < 86_400
      ? "datetime"
      : "date";
  const usage = `<b>weekly: </b>${windowText(snapshot.weekly, weeklyStyle)}\n<b>5-hour</b>: ${windowText(snapshot.fiveHour, "time")}`;
  const stale = now - snapshot.checkedAt > 360;
  return stale
    ? `${usage}\n\n⚠️ данные устарели; последняя проверка: ${formatDate(snapshot.checkedAt)}`
    : usage;
}

export function resetsMessage(
  credits: Credit[],
  checkedAt: number | null,
  now: number,
): string[] {
  const available = credits
    .filter(
      (credit) =>
        credit.status === "available" &&
        (credit.expiresAt === null || credit.expiresAt > now),
    )
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  const stale = checkedAt === null || now - checkedAt > 360;
  const suffix = stale
    ? "\n\n⚠️ список может быть устаревшим; обновление API задерживается."
    : "";
  if (!available.length) return [`доступных banked resets нет.${suffix}`];

  const chunks: string[] = [];
  let chunk = "";
  for (const credit of available) {
    const expiry = credit.expiresAt;
    const detail =
      expiry === null
        ? "no expiry"
        : `${formatRemaining(expiry - now)} (${formatDate(expiry, expiry - now < 86_400 ? "datetime" : "date")})`;
    const line = `<b>weekly reset</b> – ${detail}`;
    if (chunk && chunk.length + line.length + 1 > 3500) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += `${chunk ? "\n" : ""}${line}`;
  }
  chunks.push(chunk + suffix);
  return chunks;
}

function formatRemaining(seconds: number): string {
  const units = [
    { seconds: 7 * 86_400, unit: "week" },
    { seconds: 86_400, unit: "day" },
    { seconds: 3600, unit: "hour" },
    { seconds: 60, unit: "minute" },
  ] as const;
  for (const item of units) {
    if (seconds >= item.seconds) {
      return new Intl.RelativeTimeFormat("en-US", { numeric: "always" }).format(
        Math.floor(seconds / item.seconds),
        item.unit,
      );
    }
  }
  return "in less than a minute";
}

export function dashboardMessage(
  state: MonitorState | null,
  now: number,
): string {
  const usage = usageMessage(state?.snapshot ?? null, now);
  const resets =
    state?.creditsCheckedAt == null
      ? "список resets ещё не получен."
      : resetsMessage(
          state.snapshot.credits ?? Object.values(state.knownCredits),
          state.creditsCheckedAt,
          now,
        ).join("\n");
  const lines = `${usage}\n\n${resets}`.split("\n");
  let result = "";
  for (const line of lines) {
    if (result.length + line.length > 3800)
      return `${result}\n… additional resets omitted (Telegram message limit).`;
    result += `${result ? "\n" : ""}${line}`;
  }
  return result;
}
