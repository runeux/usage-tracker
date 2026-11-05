import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { workspaceMessageSchema } from "./model";

const rpcEnvelope = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number() }).optional(),
});
const authResult = z.object({
  authMethod: z.string().nullable(),
  authToken: z.string().min(1).nullable(),
});
const authFile = z.object({
  tokens: z.object({ account_id: z.string().min(1) }),
});

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexAuthError extends Error {
  constructor(cause?: unknown) {
    super("codex authorization could not be verified or refreshed", { cause });
  }
}

export class CodexAuth {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private ready: Promise<void> | null = null;
  private refreshAfter = 0;

  constructor(private readonly home: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const require = createRequire(import.meta.url);
    const cli = require.resolve("@openai/codex/bin/codex.js");
    const child = spawn(
      process.execPath,
      [cli, "app-server", "--listen", "stdio://"],
      {
        env: { ...process.env, CODEX_HOME: this.home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = rpcEnvelope.safeParse(raw);
      if (!parsed.success || parsed.data.id === undefined) return;
      const item = this.pending.get(parsed.data.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(parsed.data.id);
      if (parsed.data.error)
        item.reject(new Error(`codex rpc error ${parsed.data.error.code}`));
      else item.resolve(parsed.data.result);
    });
    const failed = () => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("codex auth process stopped"));
      }
      this.pending.clear();
      lines.close();
    };
    child.on("error", failed);
    child.stdin.on("error", failed);
    child.on("exit", failed);
    this.ready = this.rpc("initialize", {
      clientInfo: {
        name: "usage_tracker",
        title: "Usage Tracker",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    }).then(() => {
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    });
    return this.ready;
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child)
      return Promise.reject(new Error("codex auth process unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("codex auth request timed out"));
        this.close();
      }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async credentials(
    forceRefresh = false,
  ): Promise<{ token: string; accountId: string }> {
    try {
      await this.start();
      const refresh = forceRefresh || Date.now() >= this.refreshAfter;
      const result = authResult.parse(
        await this.rpc("getAuthStatus", {
          includeToken: true,
          refreshToken: refresh,
        }),
      );
      if (result.authMethod !== "chatgpt" || !result.authToken) {
        throw new Error("codex login required");
      }
      if (refresh) this.refreshAfter = Date.now() + 45 * 60_000;
      const file = authFile.parse(
        await Bun.file(join(this.home, "auth.json")).json(),
      );
      return { token: result.authToken, accountId: file.tokens.account_id };
    } catch (error) {
      throw new CodexAuthError(error);
    }
  }

  async workspaceMessages() {
    await this.start();
    return z
      .object({
        featureEnabled: z.boolean(),
        messages: z.array(workspaceMessageSchema),
      })
      .parse(await this.rpc("account/workspaceMessages/read", {}));
  }

  close(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.refreshAfter = 0;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("codex auth process stopped"));
    }
    this.pending.clear();
    child?.kill();
  }
}
