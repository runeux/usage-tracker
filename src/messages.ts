import type { Credit, Snapshot, UsageWindow } from "./model";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatDate(seconds: number): string {
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

  const windowText = (window: UsageWindow | null): string => {
    if (!window) return "нет данных";
    const until =
      window.resetsAt === null ? "" : ` (until ${formatDate(window.resetsAt)})`;
    return `${Math.round(window.remaining)}%${until}`;
  };
  const usage = `<b>Weekly</b>: ${windowText(snapshot.weekly)}\n<b>5h</b>: ${windowText(snapshot.fiveHour)}`;
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
  let chunk = "<b>my resets</b>";
  for (const credit of available) {
    const line = `\n${creditLabel(credit)}`;
    if (chunk.length + line.length > 3500) {
      chunks.push(chunk);
      chunk = "<b>my resets</b>";
    }
    chunk += line;
  }
  chunks.push(chunk + suffix);
  return chunks;
}
