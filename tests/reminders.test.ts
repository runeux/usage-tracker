import { describe, expect, test } from "bun:test";
import { nextPollAt, reconcile } from "../src/detect";
import type { Credit, Snapshot } from "../src/model";
import { EXPIRY_REMINDERS, expiryReminder } from "../src/reminders";
import { Store } from "../src/store";

const expiresAt = Date.parse("2026-11-06T22:43:00Z") / 1000;
const credit: Credit = {
  id: "credit-1",
  title: "Full reset (Weekly + 5 hr)",
  status: "available",
  grantedAt: expiresAt - 30 * 86_400,
  expiresAt,
};
function snapshot(
  checkedAt: number,
  credits: Credit[] | null = [credit],
): Snapshot {
  return {
    accountId: "test",
    checkedAt,
    weekly: null,
    fiveHour: null,
    credits,
  };
}

describe("banked expiry reminders", () => {
  test("each threshold has the requested wording and a stable distinct id", () => {
    const cases = [
      {
        seconds: 3 * 86_400,
        id: "banked:expiring:3d:credit-1",
        text: "Full reset will expire in 3d (Nov 7, 3:43 AM)",
      },
      {
        seconds: 86_400,
        id: "banked:expiring:credit-1",
        text: "Full reset will expire tomorrow (Nov 7, 3:43 AM)",
      },
      {
        seconds: 7200,
        id: "banked:expiring:2h:credit-1",
        text: "Full reset will expire in 2h (Nov 7, 3:43 AM)",
      },
    ];
    for (const entry of cases) {
      const due = expiresAt - entry.seconds;
      expect(expiryReminder(credit, due - 300, due - 1)).toBeNull();
      expect(expiryReminder(credit, due - 300, due)).toEqual({
        id: entry.id,
        kind: "banked-expiring",
        text: entry.text,
      });
      expect(expiryReminder(credit, due, due + 300)).toBeNull();
    }
  });
  test("the scheduler adds a poll at each reminder threshold", () => {
    for (const reminder of EXPIRY_REMINDERS) {
      const due = expiresAt - reminder.seconds;
      const now = due - 120;
      const state = reconcile(null, snapshot(now)).state;
      expect(nextPollAt(state, now, now)).toBe(due + 5);
    }
  });
  test("an outage crossing multiple thresholds sends only the most urgent reminder", () => {
    const event = expiryReminder(
      credit,
      expiresAt - 4 * 86_400,
      expiresAt - 3600,
    );
    expect(event?.id).toBe("banked:expiring:2h:credit-1");
  });
  test("already-passed thresholds are not replayed on deployment", () => {
    expect(
      expiryReminder(
        credit,
        expiresAt - 2 * 86_400,
        expiresAt - 2 * 86_400 + 300,
      ),
    ).toBeNull();
  });
  test("unavailable inventory preserves the comparison time for the next successful read", () => {
    const due = expiresAt - 86_400;
    const initial = reconcile(null, snapshot(due - 120)).state;
    const outage = reconcile(initial, snapshot(due + 5, null));
    expect(outage.events).toHaveLength(0);
    expect(outage.state.creditsCheckedAt).toBe(due - 120);
    const recovered = reconcile(outage.state, snapshot(due + 300));
    expect(recovered.events.map((event) => event.id)).toEqual([
      "banked:expiring:credit-1",
    ]);
  });
  test("redemption, expiry, and credits without an expiry suppress reminders", () => {
    for (const status of ["redeemed", "used", "expired", "redeeming"]) {
      expect(
        expiryReminder(
          { ...credit, status },
          expiresAt - 4 * 86_400,
          expiresAt - 3600,
        ),
      ).toBeNull();
    }
    expect(
      expiryReminder(
        { ...credit, expiresAt: null },
        expiresAt - 4 * 86_400,
        expiresAt - 3600,
      ),
    ).toBeNull();
    expect(
      expiryReminder(credit, expiresAt - 4 * 86_400, expiresAt),
    ).toBeNull();
  });
  test("all three reminders are queued once and preserve the old one-day deduplication key", () => {
    const store = new Store(":memory:");
    let state = reconcile(null, snapshot(expiresAt - 4 * 86_400)).state;
    store.addEvents(
      [
        {
          id: "banked:expiring:credit-1",
          kind: "banked-expiring",
          text: "previous one-day reminder",
        },
      ],
      ["telegram"],
      expiresAt - 4 * 86_400,
    );
    for (const reminder of EXPIRY_REMINDERS) {
      const current = snapshot(expiresAt - reminder.seconds + 5);
      const result = reconcile(state, current);
      store.commit(result.state, result.events, ["telegram"]);
      store.commit(result.state, result.events, ["telegram"]);
      const saved = store.load();
      if (!saved) throw new Error("missing persisted state");
      state = saved;
      expect(
        reconcile(state, { ...current, checkedAt: current.checkedAt + 1 })
          .events,
      ).toHaveLength(0);
    }
    expect(store.pending(expiresAt)).toHaveLength(3);
    expect(
      store
        .pending(expiresAt)
        .find((item) => item.event_id === "banked:expiring:credit-1")?.text,
    ).toBe("previous one-day reminder");
    store.close();
  });
});
