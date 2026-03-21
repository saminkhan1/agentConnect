import type { ParsedWebhookEvent } from "../adapters/provider-adapter.js";
import { systemDal } from "../db/dal.js";
import type { EventWriter } from "./event-writer.js";

export class WebhookProcessor {
	constructor(private readonly eventWriter: EventWriter) {}

	async processEvents(
		provider: string,
		events: ParsedWebhookEvent[],
	): Promise<void> {
		const eventsWithRef = events.filter(
			(e): e is ParsedWebhookEvent & { resourceRef: string } =>
				e.resourceRef != null,
		);
		if (eventsWithRef.length === 0) return;

		// Build ref→providerOrgId in one pass, then deduplicate refs
		const refProviderOrgId = new Map(
			eventsWithRef.map((e) => [e.resourceRef, e.providerOrgId]),
		);
		const uniqueRefs = [...refProviderOrgId.keys()];
		const fetched = await Promise.all(
			uniqueRefs.map((ref) =>
				systemDal.findResourceByProviderRef(
					provider,
					ref,
					refProviderOrgId.get(ref),
				),
			),
		);
		const byRef = new Map(
			uniqueRefs.flatMap((ref, i) => (fetched[i] ? [[ref, fetched[i]]] : [])),
		);

		await Promise.all(
			eventsWithRef.flatMap((evt) => {
				const resource = byRef.get(evt.resourceRef);
				// Providers can emit delayed lifecycle events after a resource has already been deleted.
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
