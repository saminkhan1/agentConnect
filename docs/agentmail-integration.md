# AgentMail Integration

AgentConnect uses [AgentMail](https://agentmail.to) as the email provider for provisioning inboxes, sending email, and ingesting delivery events via webhooks.

## Environment Variables

| Variable                   | Required           | Description                               |
| -------------------------- | ------------------ | ----------------------------------------- |
| `AGENTMAIL_API_KEY`        | Yes (for email)    | AgentMail API key                         |
| `AGENTMAIL_WEBHOOK_SECRET` | Yes (for webhooks) | Svix webhook signing secret (`whsec_...`) |

When these variables are absent the server starts normally but the `agentmail` provider is unavailable. Provisioning inboxes, sending mail, replying to mail, and ingesting AgentMail webhooks will fail until the adapter is configured.

## Provisioning

`POST /agents/:id/resources` with `provider: "agentmail"` and `type: "email_inbox"` provisions an AgentMail inbox. The `provider_ref` on the returned resource is the inbox email address (e.g. `agent-abc123@agentmail.to`).

## Sending Email

`POST /agents/:id/actions/send_email` sends an email from the agent's active AgentMail inbox.

**Request body**:

```json
{
  "to": ["recipient@example.com"],
  "subject": "Hello",
  "text": "Plain text body",
  "html": "<p>HTML body</p>",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"],
  "reply_to": ["replyto@example.com", "fallback@example.com"],
  "idempotency_key": "required-client-key"
}
```

`idempotency_key` is required. AgentConnect persists outbound action state keyed by `(org_id, action, idempotency_key)` so callers can safely retry the same send without creating duplicate mail.

AgentConnect records the provider `message_id` and `thread_id` returned by the send call immediately. Later webhook events add delivery lifecycle updates for the same message.

## Replying to Email

`POST /agents/:id/actions/reply_email` replies from the agent's active AgentMail inbox to a previously fetched or delivered message.

**Request body**:

```json
{
  "message_id": "msg_123",
  "text": "Thanks for the update",
  "html": "<p>Thanks for the update</p>",
  "cc": ["teammate@example.com"],
  "bcc": ["audit@example.com"],
  "reply_to": ["replyto@example.com"],
  "idempotency_key": "required-reply-key"
}
```

The same required-idempotency rules apply to replies. AgentConnect fetches the original message first so policy checks and recipient reconstruction happen against provider truth, not caller-supplied fields.

## Timeouts and Retries

AgentConnect forwards request abort signals to AgentMail for `send_email`, `reply_email`, and `get_message`. Combined with the required idempotency keys, this makes timeout-driven retries safe: use the same `idempotency_key` when retrying the same operation.

## Webhook Integration

Configure your AgentMail organization to send webhooks to:

```
POST https://your-host/webhooks/agentmail
```

### Webhook Verification

Webhooks are verified using [Svix](https://svix.com). The following headers must be present:

| Header           | Description               |
| ---------------- | ------------------------- |
| `svix-id`        | Unique message ID         |
| `svix-timestamp` | Unix timestamp            |
| `svix-signature` | `v1,<base64-hmac-sha256>` |

### Webhook Payload Contract

Fields relied on by AgentConnect:

| AgentMail `event_type` | Primary object | Fields AgentConnect reads                                                                                                                                  |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.received`     | `message`      | `message.inbox_id`, `message.message_id`, `message.thread_id`, `message.labels`, `message.from`, `message.to`, `message.subject`, `message.timestamp`      |
| `message.sent`         | `send`         | `send.inbox_id`, `send.message_id`, `send.thread_id`, `send.recipients`, `send.timestamp`                                                                  |
| `message.delivered`    | `delivery`     | `delivery.inbox_id`, `delivery.message_id`, `delivery.thread_id`, `delivery.recipients`, `delivery.timestamp`                                              |
| `message.bounced`      | `bounce`       | `bounce.inbox_id`, `bounce.message_id`, `bounce.thread_id`, `bounce.recipients`, `bounce.type`, `bounce.sub_type`, `bounce.timestamp`                      |
| `message.complained`   | `complaint`    | `complaint.inbox_id`, `complaint.message_id`, `complaint.thread_id`, `complaint.recipients`, `complaint.type`, `complaint.sub_type`, `complaint.timestamp` |
| `message.rejected`     | `reject`       | `reject.inbox_id`, `reject.message_id`, `reject.thread_id`, `reject.reason`, `reject.timestamp`                                                            |

All webhook variants also include `event_id` and `event_type`. AgentConnect uses `event_id` as the provider deduplication key.

### Event Type Mapping

| AgentMail `event_type` | Canonical event type |
| ---------------------- | -------------------- |
| `message.received`     | `email.received`     |
| `message.sent`         | `email.sent`         |
| `message.delivered`    | `email.delivered`    |
| `message.bounced`      | `email.bounced`      |
| `message.complained`   | `email.complained`   |
| `message.rejected`     | `email.rejected`     |

Unknown `event_type` values are silently skipped (webhook returns `200`).

## Known MVP Limitations

- **Synchronous processing**: Webhooks are processed inline (no queue). Processing errors are logged but do not affect the `200 OK` response sent to Svix.
