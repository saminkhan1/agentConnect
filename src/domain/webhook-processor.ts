import type { ParsedWebhookEvent } from '../adapters/provider-adapter.js';
import type { EventWriter } from './event-writer.js';
import { systemDal } from '../db/dal.js';

export class WebhookProcessor {
  constructor(private readonly eventWriter: EventWriter) {}

  async processEvents(provider: string, events: ParsedWebhookEvent[]): Promise<void> {
    for (const evt of events) {
      if (!evt.resourceRef) {
        continue;
      }

      const resource = await systemDal.findResourceByProviderRef(provider, evt.resourceRef);
      if (!resource) {
        continue;
      }

      await this.eventWriter.writeEvent({
        orgId: resource.orgId,
        agentId: resource.agentId,
        resourceId: resource.id,
        provider,
        providerEventId: evt.providerEventId,
        eventType: evt.eventType,
        occurredAt: evt.occurredAt,
        idempotencyKey: evt.idempotencyKey,
        data: evt.data,
      });
    }
  }
}
