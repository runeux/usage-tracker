import { describe, expect, test } from "bun:test";
import { nextPollAt, reconcile } from "../src/detect";
import type { Credit, MonitorState, Snapshot } from "../src/model";

const now = 1_800_000_000;
const credit: Credit = {
  id: "credit-1",
  title: "Full reset",
  status: "available",
  grantedAt: now - 100,
  expiresAt: now + 172_800,
};
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    accountId: "account-1",
    checkedAt: now,
    fiveHour: { remaining: 29, resetsAt: now + 100 },
    weekly: { remaining: 60, resetsAt: now + 1000 },
    credits: [credit],
    ...overrides,
  };
}
function baseline(overrides: Partial<Snapshot> = {}): MonitorState {
  return reconcile(null, snapshot(overrides)).state;
}

describe("reset detection", () => {
  test("first observation silently establishes a baseline", () => {
    expect(reconcile(null, snapshot()).events).toEqual([]);
  });
  test("5h reset alerts only below 30% remaining", () => {
    for (const [remaining, expected] of [
      [0, 1],
      [29, 1],
      [30, 0],
      [100, 0],
    ]) {
      const state = baseline({
        fiveHour: { remaining: remaining ?? 0, resetsAt: now + 100 },
      });
      const result = reconcile(
        state,
        snapshot({
          checkedAt: now + 105,
          fiveHour: { remaining: 100, resetsAt: now + 18_100 },
        }),
      );
      expect(
        result.events.filter((item) => item.kind === "scheduled-fiveHour"),
      ).toHaveLength(expected ?? 0);
    }
  });
  test("weekly reset alerts even at 100%, including an idle window", () => {
    const before = baseline({
      weekly: { remaining: 100, resetsAt: now + 100 },
    });
    const after = snapshot({
      checkedAt: now + 105,
      weekly: { remaining: 100, resetsAt: now + 100 },
    });
    const result = reconcile(before, after);
    expect(
      result.events.filter((item) => item.kind === "scheduled-weekly"),
    ).toHaveLength(1);
    expect(
      reconcile(result.state, { ...after, checkedAt: now + 400 }).events,
    ).toHaveLength(0);
  });
  test("restart after a deadline still catches the saved weekly reset", () => {
    const before = baseline();
    const result = reconcile(
      before,
      snapshot({
        checkedAt: now + 7200,
        weekly: { remaining: 100, resetsAt: now + 604_800 },
      }),
    );
    expect(result.events.some((item) => item.kind === "scheduled-weekly")).toBe(
      true,
    );
  });
  test("new credit is detected by id even if the available count is unchanged", () => {
    const result = reconcile(
      baseline(),
      snapshot({ credits: [{ ...credit, id: "credit-2" }] }),
    );
    expect(
      result.events.filter((item) => item.kind === "banked-new"),
    ).toHaveLength(1);
    expect(result.events.some((item) => item.kind === "banked-used")).toBe(
      false,
    );
  });
  test("first successful credit read after an outage establishes its own baseline", () => {
    expect(reconcile(baseline({ credits: null }), snapshot()).events).toEqual(
      [],
    );
  });
  test("only an explicit redeemed/used status confirms consumption", () => {
    const used = reconcile(
      baseline(),
      snapshot({ credits: [{ ...credit, status: "redeemed" }] }),
    );
    expect(used.events.map((item) => item.kind)).toEqual(["banked-used"]);
    expect(
      reconcile(baseline(), snapshot({ credits: [] })).events,
    ).toHaveLength(0);
    expect(
      reconcile(baseline(), snapshot({ credits: null })).state.knownCredits[
        credit.id
      ],
    ).toEqual(credit);
  });
  test("expiry and the most urgent crossed reminder have stable event ids", () => {
    const before = baseline();
    const expiring = reconcile(
      before,
      snapshot({
        checkedAt: credit.expiresAt === null ? now : credit.expiresAt - 60,
      }),
    );
    expect(
      expiring.events.find((item) => item.kind === "banked-expiring")?.id,
    ).toBe("banked:expiring:2h:credit-1");
    const expired = reconcile(before, snapshot({ checkedAt: now + 172_805 }));
    expect(expired.events.some((item) => item.kind === "banked-expired")).toBe(
      true,
    );
  });
  test("disappearance before the deadline is not misreported as expiry", () => {
    const result = reconcile(
      baseline(),
      snapshot({ checkedAt: now + 20, credits: [] }),
    );
    expect(result.events.some((item) => item.kind === "banked-expired")).toBe(
      false,
    );
  });
  test("instant reset requires changed weekly bounds and a second confirmation", () => {
    const updated = snapshot({
      checkedAt: now + 20,
      weekly: { remaining: 100, resetsAt: now + 604_820 },
      fiveHour: { remaining: 100, resetsAt: now + 18_020 },
    });
    const first = reconcile(baseline(), updated);
    expect(first.events).toHaveLength(0);
    expect(first.state.instantCandidate).not.toBeNull();
    const second = reconcile(first.state, { ...updated, checkedAt: now + 50 });
    expect(second.events.map((item) => item.kind)).toEqual(["instant"]);
    expect(
      reconcile(second.state, { ...updated, checkedAt: now + 350 }).events,
    ).toHaveLength(0);
  });
  test("a transient weekly jump does not become an instant reset", () => {
    const first = reconcile(
      baseline(),
      snapshot({
        checkedAt: now + 20,
        weekly: { remaining: 100, resetsAt: now + 604_820 },
      }),
    );
    expect(
      reconcile(first.state, snapshot({ checkedAt: now + 50 })).events,
    ).toHaveLength(0);
  });
  test("banked consumption does not also claim a global instant reset", () => {
    const result = reconcile(
      baseline(),
      snapshot({
        checkedAt: now + 20,
        weekly: { remaining: 100, resetsAt: now + 604_820 },
        credits: [{ ...credit, status: "redeemed" }],
      }),
    );
    expect(result.events.map((item) => item.kind)).toEqual(["banked-used"]);
    expect(result.state.instantCandidate).toBeNull();
  });
  test("missing or failed credit inventory suppresses an ambiguous instant reset", () => {
    for (const credits of [null, []]) {
      const result = reconcile(
        baseline(),
        snapshot({
          checkedAt: now + 20,
          weekly: { remaining: 100, resetsAt: now + 604_820 },
          credits,
        }),
      );
      expect(result.state.instantCandidate).toBeNull();
    }
  });
  test("different accounts cannot be compared", () => {
    expect(() =>
      reconcile(baseline(), snapshot({ accountId: "account-2" })),
    ).toThrow("account changed");
  });
  test("weekly deadline adds an earlier poll; ordinary polling stays at 5 minutes", () => {
    expect(nextPollAt(baseline({ fiveHour: null }), now, now)).toBe(now + 300);
    expect(
      nextPollAt(
        baseline({
          weekly: { remaining: 100, resetsAt: now + 100 },
          fiveHour: null,
        }),
        now,
        now,
      ),
    ).toBe(now + 105);
  });
});

test("a credit removed at its expiry still reports the known deadline without claiming unused expiry", () => {
  const before = baseline();
  const result = reconcile(
    before,
    snapshot({ checkedAt: now + 172_805, credits: [] }),
  );
  const event = result.events.find(
    (item) => item.kind === "banked-expiry-deadline",
  );
  expect(event?.id).toBe("banked:expired:credit-1");
  expect(event?.text).toContain("API не подтвердил");
  expect(result.events.some((item) => item.kind === "banked-used")).toBe(false);
});

test("banked grants include the expiry date and local time", () => {
  const checkedAt = Date.parse("2026-11-04T09:39:00Z") / 1000;
  const expiresAt = Date.parse("2026-11-05T09:39:00Z") / 1000;
  const result = reconcile(
    baseline({ checkedAt }),
    snapshot({
      checkedAt: checkedAt + 20,
      credits: [credit, { ...credit, id: "new", expiresAt }],
    }),
  );
  expect(result.events.find((event) => event.kind === "banked-new")?.text).toBe(
    "<b>new banked reset</b>: weekly – Nov 5, 2:39 PM",
  );
});

test("scheduled resets use the requested weekly and 5-hour labels", () => {
  const result = reconcile(baseline(), snapshot({ checkedAt: now + 1005 }));
  expect(
    result.events.find((event) => event.kind === "scheduled-weekly")?.text,
  ).toBe("<b>reset</b>: weekly");
  expect(
    result.events.find((event) => event.kind === "scheduled-fiveHour")?.text,
  ).toBe("<b>reset</b>: 5-hour");
});

test("instant and redeemed banked resets use the same wording as scheduled resets", () => {
  const updated = snapshot({
    checkedAt: now + 20,
    weekly: { remaining: 100, resetsAt: now + 604_820 },
  });
  const candidate = reconcile(baseline(), updated);
  const confirmed = reconcile(candidate.state, {
    ...updated,
    checkedAt: now + 50,
  });
  const redeemed = reconcile(
    baseline(),
    snapshot({ credits: [{ ...credit, status: "redeemed" }] }),
  );
  expect(confirmed.events.find((event) => event.kind === "instant")?.text).toBe(
    "<b>reset</b>: weekly",
  );
  expect(
    redeemed.events.find((event) => event.kind === "banked-used")?.text,
  ).toBe("<b>reset</b>: weekly");
});
