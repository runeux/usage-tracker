import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";

export class DeviceLogin {
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly home: string) {}

  async start(
    onComplete: (success: boolean) => Promise<void>,
  ): Promise<string> {
    if (this.child) throw new Error("login already running");
    const cli = createRequire(import.meta.url).resolve(
      "@openai/codex/bin/codex.js",
    );
    const child = spawn(process.execPath, [cli, "login", "--device-auth"], {
      env: { ...process.env, CODEX_HOME: this.home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    return new Promise((resolve, reject) => {
      let found = false;
      let settled = false;
      let output = "";
      const timeout = setTimeout(() => {
        if (!found) {
          settled = true;
          reject(new Error("login code timed out"));
          child.kill();
        }
      }, 40_000);
      const lifetime = setTimeout(() => child.kill(), 15 * 60_000);
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
        const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0];
        if (code && !found && !settled) {
          found = true;
          settled = true;
          clearTimeout(timeout);
          resolve(code);
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      const finish = (success: boolean) => {
        if (this.child !== child) return;
        this.child = null;
        clearTimeout(timeout);
        clearTimeout(lifetime);
        if (!settled) {
          settled = true;
          reject(new Error("device login unavailable"));
        }
        if (found)
          void onComplete(success).catch(() =>
            console.error("login completion notification failed"),
          );
      };
      child.on("error", () => finish(false));
      child.on("exit", (code) => finish(code === 0));
    });
  }

  close(): void {
    this.child?.kill();
  }
}
