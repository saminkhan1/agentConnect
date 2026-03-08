# AgentMail Integration

AgentConnect uses [AgentMail](https://agentmail.to) as the email provider for provisioning inboxes, sending email, and ingesting delivery events via webhooks.

## Environment Variables

| Variable                   | Required           | Description                               |
| -------------------------- | ------------------ | ----------------------------------------- |
| `AGENTMAIL_API_KEY`        | Yes (for email)    | AgentMail API key                         |
| `AGENTMAIL_WEBHOOK_SECRET` | Yes (for webhooks) | Svix webhook signing secret (`whsec_...`) |

When these variables are absent the server starts normally but `agentmail` provider is unavailable. `POST /agents/:id/actions/send_email` will return `500` and `POST /webhooks/agentmail` will return `500`.

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
  "reply_to": "replyto@example.com",
  "idempotency_key": "optional-client-key"
}
```

An `email.sent` event is written immediately with an empty `message_id`. The real `message_id` arrives later via the `message.sent` webhook.

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

| Field                | Type     | Description                                                                      |
| -------------------- | -------- | -------------------------------------------------------------------------------- |
| `event_id`           | string   | Provider event ID used for deduplication                                         |
| `event_type`         | string   | AgentMail event type (see mapping below)                                         |
| `inbox_id`           | string   | Inbox email address — maps to `provider_ref` on the resource                     |
| `message.message_id` | string   | Message identifier                                                               |
| `message.thread_id`  | string   | Thread identifier                                                                |
| `message.from`       | string   | Sender address (note: `"from"`, not `"from_"` — that is a Python SDK alias only) |
| `message.to`         | string[] | Recipient addresses                                                              |
| `message.subject`    | string   | Subject line                                                                     |
| `message.timestamp`  | string   | ISO 8601 timestamp of when the message event occurred                            |

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

- **Empty `message_id` at send time**: The `email.sent` event written at send time has `message_id: ""`. The real message ID arrives via the `message.sent` webhook and is stored as a separate event record.
- **Synchronous processing**: Webhooks are processed inline (no queue). Processing errors are logged but do not affect the `200 OK` response sent to Svix.
