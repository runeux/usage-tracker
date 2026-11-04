import { z } from "zod";
import type { Credit, UsageWindow } from "./model";

// endpoint contracts and window semantics verified against ayalx/codex-reset-tracker.
const rawWindow = z.object({
  used_percent: z.number().finite().min(0).max(100),
  limit_window_seconds: z.number().positive(),
  reset_at: z.number().int().positive().nullable(),
});
const usageSchema = z.object({
  rate_limit: z.object({
    primary_window: rawWindow.nullable(),
    secondary_window: rawWindow.nullable(),
  }),
});

export function normalizeUsage(raw: unknown): {
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
} {
  const data = usageSchema.parse(raw);
  const windows = [
    data.rate_limit.primary_window,
    data.rate_limit.secondary_window,
  ];
  const find = (seconds: number): UsageWindow | null => {
    const window = windows.find(
      (item) => item?.limit_window_seconds === seconds,
    );
    return window
      ? { remaining: 100 - window.used_percent, resetsAt: window.reset_at }
      : null;
  };
  const result = { fiveHour: find(18_000), weekly: find(604_800) };
  if (!result.fiveHour && !result.weekly)
    throw new Error("usage windows unavailable");
  return result;
}

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const rawCredits = z.object({
  available_count: z.number().int().nonnegative(),
  credits: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().nullish(),
      status: z.string(),
      granted_at: timestamp,
      expires_at: timestamp.nullable(),
      is_supported_by_plan: z.boolean().optional(),
    }),
  ),
});

export function normalizeCredits(raw: unknown): Credit[] {
  const wrapped = z
    .object({ rate_limit_reset_credits: z.unknown() })
    .safeParse(raw);
  const data = rawCredits.parse(
    wrapped.success ? wrapped.data.rate_limit_reset_credits : raw,
  );
  const rows = data.credits.filter(
    (credit) => credit.is_supported_by_plan !== false,
  );
  if (new Set(rows.map((credit) => credit.id)).size !== rows.length) {
    throw new Error("duplicate reset ids in response");
  }
  return rows.map((credit) => ({
    id: credit.id,
    title: credit.title || "Full reset",
    status: credit.status,
    grantedAt: Date.parse(credit.granted_at) / 1000,
    expiresAt:
      credit.expires_at === null ? null : Date.parse(credit.expires_at) / 1000,
  }));
}
