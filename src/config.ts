import { resolve } from "node:path";
import { z } from "zod";

export const OWNER_ID = 5766296513;
export const POLL_SECONDS = 60;

export function loadConfig() {
  const env = z
    .object({
      TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
      DATA_DIR: z.string().default("./data"),
      CODEX_HOME: z.string().default("./data/codex"),
    })
    .parse(process.env);
  return {
    token: env.TELEGRAM_BOT_TOKEN,
    dataDir: resolve(env.DATA_DIR),
    codexHome: resolve(env.CODEX_HOME),
  };
}
