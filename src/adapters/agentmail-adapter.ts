import { type AgentMail, AgentMailClient, serialization } from "agentmail";
import { Webhook } from "svix";
import { EVENT_TYPES, type EventType } from "../domain/events.js";
import type {
	DeprovisionResult,
	ParsedWebhookEvent,
	ProviderAdapter,
	ProvisionResult,
	Resource,
} from "./provider-adapter.js";

const AGENTMAIL_EVENT_TYPE_MAP: Partial<
	Record<AgentMail.EventType, EventType>
> = {
	"message.received": EVENT_TYPES.EMAIL_RECEIVED,
	"message.sent": EVENT_TYPES.EMAIL_SENT,
	"message.delivered": EVENT_TYPES.EMAIL_DELIVERED,
	"message.bounced": EVENT_TYPES.EMAIL_BOUNCED,
	"message.complained": EVENT_TYPES.EMAIL_COMPLAINED,
	"message.rejected": EVENT_TYPES.EMAIL_REJECTED,
};

const SERIALIZER_OPTIONS = { omitUndefined: true } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readProviderOrgId(
	payload: Record<string, unknown>,
): string | undefined {
	const candidate = payload.pod_id ?? payload.podId;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: undefined;
}

function serializeAgentMailValue(
	schema: {
		jsonOrThrow: (parsed: unknown, opts?: typeof SERIALIZER_OPTIONS) => unknown;
		passthrough?: () => {
			jsonOrThrow: (
				parsed: unknown,
				opts?: typeof SERIALIZER_OPTIONS,
			) => unknown;
		};
	},
	value: unknown,
): Record<string, unknown> {
	const serializer =
		typeof schema.passthrough === "function" ? schema.passthrough() : schema;
	return serializer.jsonOrThrow(value, SERIALIZER_OPTIONS) as Record<
		string,
		unknown
	>;
}

function buildWebhookEvent(args: {
	resourceRef: string;
	providerEventId: string;
	eventType: EventType;
	occurredAt: Date;
	data: Record<string, unknown>;
	providerOrgId?: string;
}): ParsedWebhookEvent {
	return {
		resourceRef: args.resourceRef,
		provider: "agentmail",
		providerEventId: args.providerEventId,
		eventType: args.eventType,
		occurredAt: args.occurredAt,
		data: args.data,
		...(args.providerOrgId ? { providerOrgId: args.providerOrgId } : {}),
	};
}

function buildReceivedWebhookEvent(
	event: AgentMail.MessageReceivedEvent,
	providerOrgId?: string,
): ParsedWebhookEvent {
	return buildWebhookEvent({
		resourceRef: event.message.inboxId,
		providerEventId: event.eventId,
		eventType: EVENT_TYPES.EMAIL_RECEIVED,
		occurredAt: event.message.timestamp,
		data: {
			message_id: event.message.messageId,
			...(event.message.threadId ? { thread_id: event.message.threadId } : {}),
			...(event.message.from ? { from: event.message.from } : {}),
			...(event.message.to.length > 0 ? { to: event.message.to } : {}),
			...(event.message.subject ? { subject: event.message.subject } : {}),
		},
		providerOrgId,
	});
}

function buildSentLifecycleWebhookEvent(
	event: AgentMail.MessageSentEvent | AgentMail.MessageDeliveredEvent,
	providerOrgId?: string,
): ParsedWebhookEvent {
	const item = event.eventType === "message.sent" ? event.send : event.delivery;

	return buildWebhookEvent({
		resourceRef: item.inboxId,
		providerEventId: event.eventId,
		eventType:
			AGENTMAIL_EVENT_TYPE_MAP[event.eventType] ?? EVENT_TYPES.EMAIL_SENT,
		occurredAt: item.timestamp,
		data: {
			message_id: item.messageId,
			...(item.threadId ? { thread_id: item.threadId } : {}),
			...(item.recipients.length > 0 ? { to: item.recipients } : {}),
		},
		providerOrgId,
	});
}

function buildBounceWebhookEvent(
	event: AgentMail.MessageBouncedEvent,
	providerOrgId?: string,
): ParsedWebhookEvent {
	const to = event.bounce.recipients
		.map((recipient) => recipient.address)
		.filter(Boolean);
	const reason = [event.bounce.type, event.bounce.subType]
		.filter(Boolean)
		.join(": ");

	return buildWebhookEvent({
		resourceRef: event.bounce.inboxId,
		providerEventId: event.eventId,
		eventType: EVENT_TYPES.EMAIL_BOUNCED,
		occurredAt: event.bounce.timestamp,
		data: {
			message_id: event.bounce.messageId,
			...(event.bounce.threadId ? { thread_id: event.bounce.threadId } : {}),
			...(to.length > 0 ? { to } : {}),
			...(reason ? { reason } : {}),
			...(event.bounce.type ? { bounce_type: event.bounce.type } : {}),
			...(event.bounce.subType
				? { bounce_sub_type: event.bounce.subType }
				: {}),
		},
		providerOrgId,
	});
}

function buildComplaintWebhookEvent(
	event: AgentMail.MessageComplainedEvent,
	providerOrgId?: string,
): ParsedWebhookEvent {
	const reason = [event.complaint.type, event.complaint.subType]
		.filter(Boolean)
		.join(": ");

	return buildWebhookEvent({
		resourceRef: event.complaint.inboxId,
		providerEventId: event.eventId,
		eventType: EVENT_TYPES.EMAIL_COMPLAINED,
		occurredAt: event.complaint.timestamp,
		data: {
			message_id: event.complaint.messageId,
			...(event.complaint.threadId
				? { thread_id: event.complaint.threadId }
				: {}),
			...(event.complaint.recipients.length > 0
				? { to: event.complaint.recipients }
				: {}),
			...(reason ? { reason } : {}),
			...(event.complaint.type ? { complaint_type: event.complaint.type } : {}),
			...(event.complaint.subType
				? { complaint_sub_type: event.complaint.subType }
				: {}),
		},
		providerOrgId,
	});
}

function buildRejectedWebhookEvent(
	event: AgentMail.MessageRejectedEvent,
	providerOrgId?: string,
): ParsedWebhookEvent {
	return buildWebhookEvent({
		resourceRef: event.reject.inboxId,
		providerEventId: event.eventId,
		eventType: EVENT_TYPES.EMAIL_REJECTED,
		occurredAt: event.reject.timestamp,
		data: {
			message_id: event.reject.messageId,
			...(event.reject.threadId ? { thread_id: event.reject.threadId } : {}),
			...(event.reject.reason ? { reason: event.reject.reason } : {}),
		},
		providerOrgId,
	});
}

function buildSendMessageRequest(
	payload: Record<string, unknown>,
): AgentMail.SendMessageRequest {
	return {
		to: payload.to as string[] | undefined,
		subject: payload.subject as string | undefined,
		text: payload.text as string | undefined,
		html: payload.html as string | undefined,
		cc: payload.cc as string[] | undefined,
		bcc: payload.bcc as string[] | undefined,
		replyTo: payload.replyTo as AgentMail.Addresses | undefined,
	};
}

function buildReplyToMessageRequest(payload: Record<string, unknown>) {
	return {
		messageId: payload.message_id as string,
		request: {
			to: payload.reply_recipients as string[] | undefined,
			text: payload.text as string | undefined,
			html: payload.html as string | undefined,
			cc: payload.cc as string[] | undefined,
			bcc: payload.bcc as string[] | undefined,
			replyTo: payload.replyTo as AgentMail.Addresses | undefined,
		} satisfies AgentMail.ReplyToMessageRequest,
	};
}

export class AgentMailAdapter implements ProviderAdapter {
	readonly providerName = "agentmail";
	private readonly client: AgentMailClient;
	private readonly webhookSecret: string;

	constructor(apiKey: string, webhookSecret: string) {
		this.client = new AgentMailClient({ apiKey });
		this.webhookSecret = webhookSecret;
	}

	async provision(
		_agentId: string,
		_config: Record<string, unknown>,
	): Promise<ProvisionResult> {
		const inbox = await this.client.inboxes.create({});
		return {
			providerRef: inbox.inboxId,
			providerOrgId: inbox.podId,
			config: { email_address: inbox.inboxId },
		};
	}

	async deprovision(resource: Resource): Promise<DeprovisionResult> {
		if (!resource.providerRef) {
			throw new Error(`Resource ${resource.id} has no providerRef`);
		}

		await this.client.inboxes.delete(resource.providerRef);
		return {};
	}

	async performAction(
		resource: Resource,
		action: string,
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const inboxId = resource.providerRef;
		if (!inboxId) {
			throw new Error("Resource has no providerRef");
		}

		if (action === "send_email") {
			const result = await this.client.inboxes.messages.send(
				inboxId,
				buildSendMessageRequest(payload),
			);
			return serializeAgentMailValue(serialization.SendMessageResponse, result);
		}

		if (action === "reply_email") {
			const { messageId, request } = buildReplyToMessageRequest(payload);
			const result = await this.client.inboxes.messages.reply(
				inboxId,
				messageId,
				request,
			);
			return serializeAgentMailValue(serialization.SendMessageResponse, result);
		}

		if (action === "get_message") {
			const result = await this.client.inboxes.messages.get(
				inboxId,
				payload.message_id as string,
			);
			return serializeAgentMailValue(serialization.Message, result);
		}

		throw new Error(`Unknown action: ${action}`);
	}

	verifyWebhook(
		rawBody: Buffer,
		headers: Record<string, string>,
	): Promise<boolean> {
		try {
			const wh = new Webhook(this.webhookSecret);
			wh.verify(rawBody, headers);
			return Promise.resolve(true);
		} catch {
			return Promise.resolve(false);
		}
	}

	parseWebhook(
		rawBody: Buffer,
		_headers: Record<string, string>,
	): Promise<ParsedWebhookEvent[]> {
		let payload: unknown;
		try {
			payload = JSON.parse(rawBody.toString()) as unknown;
		} catch {
			return Promise.resolve([]);
		}

		if (!isRecord(payload)) {
			return Promise.resolve([]);
		}

		const providerOrgId = readProviderOrgId(payload);
		const parsedEvent = serialization.WebsocketsSocketResponse.parse(payload, {
			unrecognizedObjectKeys: "passthrough",
		});

		if (!parsedEvent.ok || parsedEvent.value.type !== "event") {
			return Promise.resolve([]);
		}

		switch (parsedEvent.value.eventType) {
			case "message.received":
				return Promise.resolve([
					buildReceivedWebhookEvent(parsedEvent.value, providerOrgId),
				]);
			case "message.sent":
			case "message.delivered":
				return Promise.resolve([
					buildSentLifecycleWebhookEvent(parsedEvent.value, providerOrgId),
				]);
			case "message.bounced":
				return Promise.resolve([
					buildBounceWebhookEvent(parsedEvent.value, providerOrgId),
				]);
			case "message.complained":
				return Promise.resolve([
					buildComplaintWebhookEvent(parsedEvent.value, providerOrgId),
				]);
			case "message.rejected":
				return Promise.resolve([
					buildRejectedWebhookEvent(parsedEvent.value, providerOrgId),
				]);
			default:
				return Promise.resolve([]);
		}
	}
}
