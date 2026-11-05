import { z } from "zod";
import { type CodexAuth, CodexAuthError } from "./auth";
import { type Announcement, announcementSchema, type Snapshot } from "./model";
import { normalizeCredits, normalizeUsage } from "./normalize";

export class SourceError extends Error {
  constructor(
    readonly source: string,
    readonly status: number | null = null,
  ) {
    super(`${source} unavailable${status === null ? "" : ` (http ${status})`}`);
  }
}

export class CodexProvider {
  constructor(private readonly auth: Pick<CodexAuth, "credentials">) {}

  private async request(
    path: string,
    credentials: { token: string; accountId: string },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`https://chatgpt.com/backend-api/wham/${path}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credentials.token}`,
          "ChatGPT-Account-ID": credentials.accountId,
          "OpenAI-Beta": "codex-1",
          "OAI-Language": "en",
          "User-Agent": "usage-tracker/1.0",
          originator: "usage_tracker",
        },
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new SourceError(path);
    }
    if (!response.ok) throw new SourceError(path, response.status);
    try {
      return await response.json();
    } catch {
      throw new SourceError(path);
    }
  }

  async read(): Promise<{ snapshot: Snapshot; creditsError: boolean }> {
    let credentials = await this.auth.credentials();
    const read = async (path: string) => {
      try {
        return await this.request(path, credentials);
      } catch (error) {
        if (!(error instanceof SourceError) || error.status !== 401)
          throw error;
        credentials = await this.auth.credentials(true);
        try {
          return await this.request(path, credentials);
        } catch (retryError) {
          if (retryError instanceof SourceError && retryError.status === 401)
            throw new CodexAuthError(retryError);
          throw retryError;
        }
      }
    };
    const usage = normalizeUsage(await read("usage"));
    let credits: Snapshot["credits"] = null;
    try {
      credits = normalizeCredits(await read("rate-limit-reset-credits"));
    } catch (error) {
      if (error instanceof CodexAuthError) throw error;
      /* preserve the last known inventory when the independent credit read fails. */
    }
    return {
      snapshot: {
        accountId: credentials.accountId,
        checkedAt: Date.now() / 1000,
        ...usage,
        credits,
      },
      creditsError: credits === null,
    };
  }
}

export async function readAnnouncements(): Promise<Announcement[]> {
  let response: Response;
  try {
    response = await fetch("https://tokenusage.dev/api/resets", {
      headers: {
        Accept: "application/json",
        "User-Agent": "usage-tracker/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SourceError("announcements");
  }
  if (!response.ok) throw new SourceError("announcements", response.status);
  return z
    .object({ resets: z.array(announcementSchema) })
    .parse(await response.json()).resets;
}
