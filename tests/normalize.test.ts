import { describe, expect, test } from "bun:test";
import {
  creditLabel,
  escapeHtml,
  resetsMessage,
  usageMessage,
} from "../src/messages";
import { normalizeCredits, normalizeUsage } from "../src/normalize";

const usage = {
  rate_limit: {
    primary_window: {
      used_percent: 33,
      limit_window_seconds: 18000,
      reset_at: 1_800_000_100,
    },
    secondary_window: {
      used_percent: 72,
      limit_window_seconds: 604800,
      reset_at: 1_800_001_000,
    },
  },
};
const rawCredit = {
  id: "credit-1",
  title: "Full reset (Weekly + 5 hr)",
  status: "available",
  granted_at: "2026-11-01T21:47:30.762397Z",
  expires_at: "2026-12-01T21:47:30.762397Z",
  is_supported_by_plan: true,
};

describe("upstream contracts", () => {
  test("usage is the remaining allowance, grouped by duration rather than position", () => {
    expect(normalizeUsage(usage)).toEqual({
      fiveHour: { remaining: 67, resetsAt: 1_800_000_100 },
      weekly: { remaining: 28, resetsAt: 1_800_001_000 },
    });
    expect(
      normalizeUsage({
        rate_limit: {
          primary_window: usage.rate_limit.secondary_window,
          secondary_window: usage.rate_limit.primary_window,
        },
      }),
    ).toEqual(normalizeUsage(usage));
  });
  test("invalid usage data is rejected rather than treated as a reset", () => {
    expect(() => normalizeUsage({ rate_limit: {} })).toThrow();
    expect(() =>
      normalizeUsage({
        rate_limit: {
          ...usage.rate_limit,
          primary_window: {
            ...usage.rate_limit.primary_window,
            used_percent: -1,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      normalizeUsage({
        rate_limit: { primary_window: null, secondary_window: null },
      }),
    ).toThrow();
  });
  test("credit identity and terminal states are preserved", () => {
    const credits = normalizeCredits({
      available_count: 1,
      credits: [
        rawCredit,
        { ...rawCredit, id: "credit-2", status: "redeemed" },
      ],
    });
    expect(credits.map((credit) => [credit.id, credit.status])).toEqual([
      ["credit-1", "available"],
      ["credit-2", "redeemed"],
    ]);
  });
  test("wrapped credits and fractional ISO timestamps are supported", () => {
    const credits = normalizeCredits({
      rate_limit_reset_credits: { available_count: 1, credits: [rawCredit] },
    });
    expect(credits[0]?.expiresAt).toBe(Date.parse(rawCredit.expires_at) / 1000);
  });
  test("partial or malformed credit payloads are not mistaken for an empty inventory", () => {
    expect(() => normalizeCredits({ available_count: 3 })).toThrow();
    expect(() =>
      normalizeCredits({
        available_count: 1,
        credits: [{ ...rawCredit, expires_at: "invalid" }],
      }),
    ).toThrow();
    expect(() =>
      normalizeCredits({ available_count: 2, credits: [rawCredit, rawCredit] }),
    ).toThrow();
  });
  test("unsupported resets are excluded", () => {
    expect(
      normalizeCredits({
        available_count: 0,
        credits: [{ ...rawCredit, is_supported_by_plan: false }],
      }),
    ).toEqual([]);
  });
});

describe("telegram presentation", () => {
  test("usage has the requested labels and marks old data", () => {
    const snapshot = {
      accountId: "test",
      checkedAt: 1000,
      ...normalizeUsage(usage),
      weekly: {
        remaining: 28,
        resetsAt: Date.parse("2026-12-01T21:47:00Z") / 1000,
      },
      fiveHour: {
        remaining: 67,
        resetsAt: Date.parse("2026-11-03T22:41:00Z") / 1000,
      },
      credits: null,
    };
    expect(usageMessage(snapshot, 1001)).toBe(
      "<b>Weekly</b>: 28% (until Dec 2, 2:47 AM)\n<b>5h</b>: 67% (until Nov 4, 3:41 AM)",
    );
    expect(usageMessage(snapshot, 2000)).toContain("данные устарели");
  });
  test("reset labels use local time without a timezone suffix", () => {
    const credit = normalizeCredits({
      available_count: 1,
      credits: [rawCredit],
    })[0];
    if (!credit) throw new Error("missing fixture credit");
    expect(creditLabel(credit)).toBe("Full reset — Dec 2, 2:47 AM");
    expect(resetsMessage([credit], 1000, 1001)).toEqual([
      "<b>my resets</b>\nFull reset — Dec 2, 2:47 AM",
    ]);
  });
  test("untrusted titles are escaped, and expired or redeemed credits are hidden", () => {
    const credit = normalizeCredits({
      available_count: 1,
      credits: [{ ...rawCredit, title: "<b>reset</b> & free" }],
    })[0];
    if (!credit) throw new Error("missing fixture credit");
    expect(creditLabel(credit)).toStartWith(
      "&lt;b&gt;reset&lt;/b&gt; &amp; free",
    );
    expect(escapeHtml("A&B<C>")).toBe("A&amp;B&lt;C&gt;");
    expect(
      resetsMessage([{ ...credit, status: "redeemed" }], 1000, 1001)[0],
    ).toBe("доступных banked resets нет.");
    expect(resetsMessage([{ ...credit, expiresAt: 999 }], 1000, 1001)[0]).toBe(
      "доступных banked resets нет.",
    );
  });
});
