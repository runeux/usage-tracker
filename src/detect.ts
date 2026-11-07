import { POLL_SECONDS } from "./config";
import { formatDate } from "./messages";
import type { Event, MonitorState, Snapshot } from "./model";
import { EXPIRY_REMINDERS, expiryReminder } from "./reminders";

const isUsed = (status: string) => status === "used" || status === "redeemed";

export function reconcile(
  previous: MonitorState | null,
  current: Snapshot,
): {
  state: MonitorState;
  events: Event[];
} {
  if (previous && previous.snapshot.accountId !== current.accountId) {
    throw new Error(
      "codex account changed; refusing to compare different accounts",
    );
  }
  const events: Event[] = [];
  const knownCredits = { ...previous?.knownCredits };
  let usedBanked = false;
  for (const credit of current.credits ?? []) {
    const old = knownCredits[credit.id];
    knownCredits[credit.id] = credit;
    if (!previous || previous.creditsCheckedAt === null) continue;
    if (
      credit.status === "available" &&
      !old &&
      (credit.expiresAt === null || credit.expiresAt > current.checkedAt)
    ) {
      events.push({
        id: `banked:new:${credit.id}`,
        kind: "banked-new",
        text: `<b>new banked reset</b>: weekly – ${credit.expiresAt === null ? "no expiry" : formatDate(credit.expiresAt)}`,
      });
    }
    if (isUsed(credit.status) && old && !isUsed(old.status)) {
      usedBanked = true;
      events.push({
        id: `banked:used:${credit.id}`,
        kind: "banked-used",
        text: "<b>reset</b>: weekly",
      });
    }
    const expired =
      credit.status === "expired" ||
      (credit.status === "available" &&
        credit.expiresAt !== null &&
        credit.expiresAt <= current.checkedAt);
    if (expired && old?.status === "available") {
      events.push({
        id: `banked:expired:${credit.id}`,
        kind: "banked-expired",
        text: "<b>weekly banked reset</b> has expired",
      });
    } else {
      const reminder = expiryReminder(
        credit,
        previous.creditsCheckedAt,
        current.checkedAt,
      );
      if (reminder) events.push(reminder);
    }
  }

  if (previous && current.credits !== null) {
    for (const credit of previous.snapshot.credits ?? []) {
      if (
        credit.status !== "available" ||
        credit.expiresAt === null ||
        credit.expiresAt > current.checkedAt ||
        credit.expiresAt <= previous.snapshot.checkedAt ||
        current.credits.some((item) => item.id === credit.id)
      )
        continue;
      events.push({
        id: `banked:expired:${credit.id}`,
        kind: "banked-expiry-deadline",
        text: "<b>weekly banked reset</b> has expired",
      });
    }
  }

  let instantCandidate = previous?.instantCandidate ?? null;
  if (previous) {
    for (const [key, label] of [
      ["weekly", "weekly"],
      ["fiveHour", "5-hour"],
    ] as const) {
      const old = previous.snapshot[key];
      const deadline = old?.resetsAt;
      if (
        !old ||
        deadline == null ||
        deadline > current.checkedAt ||
        deadline <= previous.snapshot.checkedAt
      )
        continue;
      if (key === "fiveHour" && old.remaining >= 30) continue;
      events.push({
        id: `scheduled:${key}:${deadline}`,
        kind: `scheduled-${key}`,
        text: `<b>reset</b>: ${label}`,
      });
    }

    const old = previous.snapshot.weekly;
    const weekly = current.weekly;
    const inventoryComplete =
      current.credits !== null && previous.creditsCheckedAt !== null;
    const missingBanked =
      inventoryComplete &&
      Object.values(previous.knownCredits).some(
        (credit) =>
          credit.status === "available" &&
          (credit.expiresAt === null || credit.expiresAt > current.checkedAt) &&
          !current.credits?.some((item) => item.id === credit.id),
      );
    if (usedBanked || missingBanked || !inventoryComplete) {
      instantCandidate = null;
    } else if (instantCandidate) {
      if (
        weekly?.resetsAt === instantCandidate.resetsAt &&
        weekly.remaining <= 100
      ) {
        events.push({
          id: `instant:${weekly.resetsAt}`,
          kind: "instant",
          text: "<b>reset</b>: weekly",
        });
        instantCandidate = null;
      } else {
        instantCandidate = null;
      }
    } else if (
      old?.resetsAt &&
      weekly?.resetsAt &&
      weekly.remaining === 100 &&
      old.resetsAt > current.checkedAt + 120 &&
      Math.abs(weekly.resetsAt - old.resetsAt) > 120
    ) {
      instantCandidate = {
        resetsAt: weekly.resetsAt,
        firstSeenAt: current.checkedAt,
      };
    }
  }

  return {
    state: {
      snapshot: current,
      knownCredits,
      creditsCheckedAt:
        current.credits === null
          ? (previous?.creditsCheckedAt ?? null)
          : current.checkedAt,
      instantCandidate,
    },
    events,
  };
}

export function nextPollAt(
  state: MonitorState | null,
  lastPollAt: number,
  now: number,
): number {
  let next = lastPollAt + POLL_SECONDS;
  if (!state) return next;
  if (state.instantCandidate) next = Math.min(next, now + 30);
  for (const window of [state.snapshot.weekly, state.snapshot.fiveHour]) {
    if (window?.resetsAt && window.resetsAt > now)
      next = Math.min(next, window.resetsAt + 5);
  }
  for (const credit of Object.values(state.knownCredits)) {
    if (credit.status !== "available" || credit.expiresAt === null) continue;
    const expiresAt = credit.expiresAt;
    for (const due of [
      ...EXPIRY_REMINDERS.map((reminder) => expiresAt - reminder.seconds),
      expiresAt,
    ]) {
      if (due > now) next = Math.min(next, due + 5);
    }
  }
  return next;
}
