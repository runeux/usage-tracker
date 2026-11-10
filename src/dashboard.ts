import { z } from "zod";
import { dashboardMessage } from "./messages";
import type { Store } from "./store";

export interface DashboardTransport {
  send(text: string): Promise<number>;
  edit(id: number, text: string): Promise<boolean>;
  remove(id: number): Promise<void>;
}
const savedSchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
});

export class Dashboard {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly transport: DashboardTransport,
  ) {}

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    // callers receive the error; keep later operations runnable after a failure.
    this.queue = result.catch(() => {});
    return result;
  }

  private saved() {
    const raw = this.store.get("dashboard");
    return raw === null || raw === "null"
      ? null
      : savedSchema.parse(JSON.parse(raw));
  }

  replace(readNow: () => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      await readNow();
      const old = this.saved();
      const text = dashboardMessage(this.store.load(), Date.now() / 1000);
      const id = await this.transport.send(text);
      this.store.set("dashboard", JSON.stringify({ id, text }));
      if (old) await this.transport.remove(old.id);
    });
  }

  refresh(): Promise<void> {
    return this.serialize(async () => {
      const saved = this.saved();
      if (!saved) return;
      const text = dashboardMessage(this.store.load(), Date.now() / 1000);
      if (text === saved.text) return;
      const exists = await this.transport.edit(saved.id, text);
      this.store.set(
        "dashboard",
        exists ? JSON.stringify({ id: saved.id, text }) : "null",
      );
    });
  }
}
