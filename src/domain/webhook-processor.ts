import type { ParsedWebhookEvent } from '../adapters/provider-adapter.js';
import type { EventWriter } from './event-writer.js';
import { systemDal } from '../db/dal.js';

export class WebhookProcessor {
  constructor(private readonly eventWriter: EventWriter) {}

  async processEvents(provider: string, events: ParsedWebhookEvent[]): Promise<void> {
    const eventsWithRef = events.filter(
      (e): e is ParsedWebhookEvent & { resourceRef: string } => e.resourceRef != null,
    );
    if (eventsWithRef.length === 0) return;

    const uniqueRefs = [...new Set(eventsWithRef.map((e) => e.resourceRef))];
    const fetched = await Promise.all(
      uniqueRefs.map((ref) => systemDal.findResourceByProviderRef(provider, ref)),
    );
    const byRef = new Map(uniqueRefs.flatMap((ref, i) => (fetched[i] ? [[ref, fetched[i]]] : [])));

    await Promise.all(
      eventsWithRef.flatMap((evt) => {
        const resource = byRef.get(evt.resourceRef);
        if (!resource) return [];
        return [
          this.eventWriter.writeEvent({
            orgId: resource.orgId,
            agentId: resource.agentId,
            resourceId: resource.id,
            provider,
            providerEventId: evt.providerEventId,
            eventType: evt.eventType,
            occurredAt: evt.occurredAt,
            idempotencyKey: evt.idempotencyKey,
            data: evt.data,
          }),
        ];
      }),
    );
  }
}
