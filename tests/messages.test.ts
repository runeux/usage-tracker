import { describe, expect, test } from "bun:test";
import {
  creditLabel,
  dashboardMessage,
  escapeHtml,
  resetsMessage,
  usageMessage,
} from "../src/messages";
import type { Credit, Snapshot } from "../src/model";

const now = Date.parse("2026-11-05T15:47:00Z") / 1000;
const credit: Credit = {
  id: "credit",
  title: "Full reset (Weekly + 5 hr)",
  status: "available",
  grantedAt: now - 1000,
  expiresAt: now + 3 * 3600,
};
function snapshot(): Snapshot {
  return {
    accountId: "test",
    checkedAt: now,
    weekly: {
      remaining: 21,
      resetsAt: Date.parse("2026-11-05T18:05:00Z") / 1000,
    },
    fiveHour: {
      remaining: 100,
      resetsAt: Date.parse("2026-11-06T14:16:00Z") / 1000,
    },
    credits: [credit],
  };
}

describe("usage presentation", () => {
  test("weekly within 24h includes the time; 5-hour always shows only time", () => {
    expect(usageMessage(snapshot(), now)).toBe(
      "<b>weekly: </b>21% – Nov 5, 11:05 PM\n<b>5-hour</b>: 100% – 7:16 PM",
    );
  });
  test("weekly at least 24h away shows only its date", () => {
    for (const seconds of [86_400, 2 * 86_400]) {
      const data = snapshot();
      data.weekly = { remaining: 21, resetsAt: now + seconds };
      expect(usageMessage(data, now).split("\n")[0]).toBe(
        `<b>weekly: </b>21% – Nov ${seconds === 86_400 ? 6 : 7}`,
      );
    }
    const data = snapshot();
    data.weekly = { remaining: 21, resetsAt: now + 86_399 };
    expect(usageMessage(data, now).split("\n")[0]).toBe(
      "<b>weekly: </b>21% – Nov 6, 8:46 PM",
    );
  });
  test("missing windows or deadlines do not invent a date or allowance", () => {
    const data = snapshot();
    data.weekly = null;
    data.fiveHour = { remaining: 100, resetsAt: null };
    expect(usageMessage(data, now)).toBe(
      "<b>weekly: </b>нет данных\n<b>5-hour</b>: 100%",
    );
    expect(usageMessage(null, now)).toContain("ещё не получены");
  });
  test("old data is visibly marked", () => {
    expect(usageMessage(snapshot(), now + 361)).toContain("данные устарели");
  });
});

describe("reset presentation", () => {
  test("rows have bold bullet titles, relative expiry, and conditional dates", () => {
    const credits = [
      { ...credit, id: "weeks", expiresAt: now + 3 * 7 * 86_400 },
      { ...credit, id: "days", expiresAt: now + 2 * 86_400 },
      credit,
    ];
    expect(resetsMessage(credits, now, now)).toEqual([
      "<b>weekly reset</b> – in 3 hours (Nov 5, 11:47 PM)\n<b>weekly reset</b> – in 2 days (Nov 7)\n<b>weekly reset</b> – in 3 weeks (Nov 26)",
    ]);
  });
  test("exactly 24 hours uses a date; below 24 hours includes time", () => {
    expect(
      resetsMessage([{ ...credit, expiresAt: now + 86_400 }], now, now)[0],
    ).toBe("<b>weekly reset</b> – in 1 day (Nov 6)");
    expect(
      resetsMessage([{ ...credit, expiresAt: now + 86_399 }], now, now)[0],
    ).toBe("<b>weekly reset</b> – in 23 hours (Nov 6, 8:46 PM)");
  });
  test("relative units handle singulars, minutes, and sub-minute expiry", () => {
    for (const [seconds, text] of [
      [7 * 86_400, "in 1 week"],
      [3600, "in 1 hour"],
      [60, "in 1 minute"],
      [59, "in less than a minute"],
    ] as const) {
      expect(
        resetsMessage([{ ...credit, expiresAt: now + seconds }], now, now)[0],
      ).toContain(` – ${text} (`);
    }
  });
  test("non-expiring credits do not invent a deadline", () => {
    expect(resetsMessage([{ ...credit, expiresAt: null }], now, now)).toEqual([
      "<b>weekly reset</b> – no expiry",
    ]);
  });
  test("reset labels are fixed and terminal or expired credits are hidden", () => {
    expect(
      resetsMessage([{ ...credit, title: "<b>reset</b> & free" }], now, now)[0],
    ).toStartWith("<b>weekly reset</b> – ");
    expect(escapeHtml("A&B<C>")).toBe("A&amp;B&lt;C&gt;");
    expect(
      resetsMessage(
        [
          { ...credit, status: "redeemed" },
          { ...credit, expiresAt: now },
        ],
        now,
        now,
      ),
    ).toEqual(["доступных banked resets нет."]);
  });
  test("long lists split into bounded messages and retain all rows", () => {
    const credits = Array.from({ length: 150 }, (_, i) => ({
      ...credit,
      id: String(i),
    }));
    const chunks = resetsMessage(credits, now, now);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3500)).toBe(true);
    expect(chunks.join("\n").split("\n")).toHaveLength(150);
  });
  test("stale inventory is marked and notification labels retain their full timestamp", () => {
    expect(resetsMessage([credit], now - 361, now)[0]).toContain(
      "список может быть устаревшим",
    );
    expect(creditLabel(credit)).toBe("Full reset — Nov 5, 11:47 PM");
  });
});

test("combined dashboard is exactly one bounded message", () => {
  const data = snapshot();
  data.credits = Array.from({ length: 150 }, (_, i) => ({
    ...credit,
    id: String(i),
  }));
  const text = dashboardMessage(
    {
      snapshot: data,
      knownCredits: {},
      creditsCheckedAt: now,
      instantCandidate: null,
    },
    now,
  );
  expect(text).toStartWith("<b>weekly: </b>21%");
  expect(text).toContain("\n\n<b>weekly reset</b>");
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(text).toContain("additional resets omitted");
});
