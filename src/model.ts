import { z } from "zod";

export const windowSchema = z.object({
  remaining: z.number().min(0).max(100),
  resetsAt: z.number().int().positive().nullable(),
});
export type UsageWindow = z.infer<typeof windowSchema>;

export const creditSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.string(),
  grantedAt: z.number(),
  expiresAt: z.number().nullable(),
});
export type Credit = z.infer<typeof creditSchema>;

export const snapshotSchema = z.object({
  accountId: z.string().min(1),
  checkedAt: z.number(),
  fiveHour: windowSchema.nullable(),
  weekly: windowSchema.nullable(),
  credits: z.array(creditSchema).nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const announcementSchema = z.object({
  postId: z.string().min(1),
  url: z.url().refine((url) => {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "x.com";
  }),
  postedAt: z.iso.datetime(),
  resetType: z.enum(["automatic", "banked", "both"]).nullable(),
});
export type Announcement = z.infer<typeof announcementSchema>;

export type Event = {
  id: string;
  kind: string;
  text: string;
};

export const monitorStateSchema = z.object({
  snapshot: snapshotSchema,
  knownCredits: z.record(z.string(), creditSchema),
  creditsCheckedAt: z.number().nullable(),
  instantCandidate: z
    .object({ resetsAt: z.number(), firstSeenAt: z.number() })
    .nullable(),
});
export type MonitorState = z.infer<typeof monitorStateSchema>;

export const workspaceMessageSchema = z.object({
  messageId: z.string().min(1),
  messageType: z.string(),
  messageBody: z.string(),
  createdAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
});
export type WorkspaceMessage = z.infer<typeof workspaceMessageSchema>;
