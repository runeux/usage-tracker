import type { Store } from "./store";

export interface Channel {
  readonly id: string;
  send(text: string): Promise<void>;
}

export class RejectedDelivery extends Error {
  constructor(readonly retryAfter: number | null) {
    super("delivery explicitly rejected");
  }
}

export async function deliverPending(
  store: Store,
  channels: Channel[],
  now: number,
): Promise<void> {
  for (const delivery of store.pending(now)) {
    const channel = channels.find((item) => item.id === delivery.channel);
    if (!channel) continue;
    store.mark(delivery, "sending");
    try {
      await channel.send(delivery.text);
      store.mark(delivery, "sent");
    } catch (error) {
      if (error instanceof RejectedDelivery) {
        if (error.retryAfter !== null)
          store.retry(delivery, now + error.retryAfter);
        else store.mark(delivery, "failed");
      } else {
        // telegram has no idempotency key; retrying an ambiguous request can send a duplicate.
        store.mark(delivery, "uncertain");
      }
      console.error(
        JSON.stringify({
          event: "delivery_failed",
          channel: delivery.channel,
          id: delivery.event_id,
        }),
      );
    }
  }
}
