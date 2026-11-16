import type { Delivery } from "./messages.ts";

export interface Outbox {
  ready(): Promise<Delivery[]>;
  started(publicationId: string, retryDelayMs: number): Promise<boolean>;
  failed(publicationId: string, error: string, retryDelayMs: number): Promise<void>;
  published(publicationId: string): Promise<void>;
}

export type PublicationResult = { accepted: true } | { accepted: false; error: string };

// A negative result is a resolved, unroutable send; a rejection invalidates the transport.
export async function relayReadyPublications(outbox: Outbox, publish: (delivery: Delivery) => Promise<PublicationResult>, retryDelayMs: number) {
  for (const delivery of await outbox.ready()) {
    if (!await outbox.started(delivery.publicationId, retryDelayMs)) continue;
    let result: PublicationResult;
    try {
      result = await publish(delivery);
      if (result.accepted) {
        await outbox.published(delivery.publicationId);
        continue;
      }
    } catch (error) {
      await outbox.failed(delivery.publicationId, error instanceof Error ? error.message : "Publication failed", retryDelayMs);
      throw error;
    }
    await outbox.failed(delivery.publicationId, result.error, retryDelayMs);
  }
}
