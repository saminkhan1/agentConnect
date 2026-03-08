import { AgentMailClient } from 'agentmail';
import { Webhook } from 'svix';

import type {
  ParsedWebhookEvent,
  ProviderAdapter,
  ProvisionResult,
  DeprovisionResult,
  Resource,
} from './provider-adapter.js';
import { EVENT_TYPES, type EventType } from '../domain/events.js';

type AgentMailWebhookPayload = {
  event_type: string;
  event_id: string; // → provider_event_id for deduplication
  organization_id: string;
  inbox_id: string; // → resourceRef (= provider_ref on resources row)
  message: {
    message_id: string;
    thread_id: string;
    from: string; // Note: "from" NOT "from_" (Python SDK alias only)
    to: string[];
    subject: string;
    timestamp: string;
  };
};

const AGENTMAIL_EVENT_TYPE_MAP: Partial<Record<string, EventType>> = {
  'message.received': EVENT_TYPES.EMAIL_RECEIVED,
  'message.sent': EVENT_TYPES.EMAIL_SENT,
  'message.delivered': EVENT_TYPES.EMAIL_DELIVERED,
  'message.bounced': EVENT_TYPES.EMAIL_BOUNCED,
  'message.complained': EVENT_TYPES.EMAIL_COMPLAINED,
  'message.rejected': EVENT_TYPES.EMAIL_REJECTED,
};

export class AgentMailAdapter implements ProviderAdapter {
  readonly providerName = 'agentmail';
  private readonly client: AgentMailClient;
  private readonly webhookSecret: string;

  constructor(apiKey: string, webhookSecret: string) {
    this.client = new AgentMailClient({ apiKey });
    this.webhookSecret = webhookSecret;
  }

  async provision(_agentId: string, _config: Record<string, unknown>): Promise<ProvisionResult> {
    const inbox = await this.client.inboxes.create(undefined);
    return { providerRef: inbox.inboxId, providerOrgId: inbox.podId };
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
    if (action !== 'send_email') {
      throw new Error(`Unknown action: ${action}`);
    }

    const inboxId = resource.providerRef;
    if (!inboxId) {
      throw new Error('Resource has no providerRef');
    }

    const result = await this.client.inboxes.messages.send(inboxId, {
      to: payload['to'] as string[] | undefined,
      subject: payload['subject'] as string | undefined,
      text: payload['text'] as string | undefined,
      html: payload['html'] as string | undefined,
      cc: payload['cc'] as string[] | undefined,
      bcc: payload['bcc'] as string[] | undefined,
      replyTo: payload['replyTo'] as string | undefined,
    });

    return { message_id: result.messageId };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean> {
    try {
      const wh = new Webhook(this.webhookSecret);
      wh.verify(rawBody, headers);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  parseWebhook(rawBody: Buffer, _headers: Record<string, string>): Promise<ParsedWebhookEvent[]> {
    let payload: AgentMailWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString()) as AgentMailWebhookPayload;
    } catch {
      return Promise.resolve([]);
    }

    const eventType = AGENTMAIL_EVENT_TYPE_MAP[payload.event_type];
    if (!eventType) {
      return Promise.resolve([]);
    }

    const msg = payload.message;

    return Promise.resolve([
      {
        resourceRef: payload.inbox_id,
        providerOrgId: payload.organization_id,
        provider: this.providerName,
        providerEventId: payload.event_id,
        eventType,
        occurredAt: new Date(msg.timestamp),
        data: {
          message_id: msg.message_id,
          thread_id: msg.thread_id,
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
        },
      },
    ]);
  }
}
