import { creditTitle, formatDate } from "./messages";
import type { Credit, Event } from "./model";

export const EXPIRY_REMINDERS = [
  { id: "3d", seconds: 3 * 86_400, label: "in 3d" },
  { id: "1d", seconds: 86_400, label: "tomorrow" },
  { id: "2h", seconds: 2 * 3600, label: "in 2h" },
] as const;

export function expiryReminder(
  credit: Credit,
  since: number,
  now: number,
): Event | null {
  const expiresAt = credit.expiresAt;
  if (credit.status !== "available" || expiresAt === null || expiresAt <= now)
    return null;
  const reminder = EXPIRY_REMINDERS.findLast(({ seconds }) => {
    const due = expiresAt - seconds;
    return since < due && due <= now;
  });
  if (!reminder) return null;

  // preserve the existing one-day id so delivered reminders stay deduplicated.
  const id =
    reminder.id === "1d"
      ? `banked:expiring:${credit.id}`
      : `banked:expiring:${reminder.id}:${credit.id}`;
  return {
    id,
    kind: "banked-expiring",
    text: `${creditTitle(credit)} will expire ${reminder.label} (${formatDate(expiresAt)})`,
  };
}
