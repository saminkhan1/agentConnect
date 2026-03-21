# OpenClaw and Hermes Integration Guide

This guide defines the strict integration target for AgentConnect Phase E. We only call an integration "supported" when the codebase passes the conformance and reliability checks described here.

Official references used for this guide:

- OpenClaw docs: <https://docs.openclaw.ai/>
- Hermes Agent docs: <https://hermes-agent.nousresearch.com/docs/>

## Executive Summary

| Direction                | Official surface                                                                                           | AgentConnect decision                                                                                                   | Status                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Hermes -> AgentConnect   | Remote MCP server via `mcp_servers` with `url`, `headers`, `timeout`, `connect_timeout`                    | Support directly via hosted HTTP `/mcp` and local stdio MCP. Keep MCP as a thin facade over existing routes/services.   | Verified in automated conformance tests; hosted staging smoke still required before production claims |
| OpenClaw -> AgentConnect | OpenClaw operator workflows over authenticated Gateway HTTP calls                                          | OpenClaw workflows call AgentConnect REST APIs with stable idempotency keys.                                            | Supported now                                                                                         |
| AgentConnect -> OpenClaw | OpenClaw hooks (`POST /hooks/agent`, `POST /hooks/wake`) with dedicated hook auth and routing restrictions | Outbound webhook subscriptions deliver canonical events or bounded OpenClaw hook envelopes. No generic workflow engine. | Verified in automated conformance tests; staging smoke still required before production claims        |

## Architecture Guardrails

These keep the integration aligned with the lean MVP plan and existing system design:

- No new orchestrator-specific service. Keep one codebase and the same API + Worker split.
- Hermes support is protocol-level only: MCP tools call existing Fastify routes/services, not a parallel business-logic path.
- OpenClaw support is transport-level only: outbound worker fanout sends canonical events or a small OpenClaw hook envelope. No embedded workflow runtime.
- Do not introduce orchestrator-specific persistence outside bounded webhook subscription metadata.
- Do not mark README or docs as "production ready" for Hermes/OpenClaw until the named test suites and staging smoke checks pass.

## Hermes Integration

### Official contract

Hermes documents remote MCP servers through `mcp_servers` entries that support:

- `url`
- `headers`
- `timeout`
- `connect_timeout`

Hermes then auto-registers remote MCP tools with the `mcp_{server}_{tool}` naming pattern.

### AgentConnect mapping

Use AgentConnect as a remote MCP server:

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  agentconnect:
    url: 'https://agentconnect.example.com/mcp'
    headers:
      Authorization: 'Bearer sk_...'
    timeout: 180
    connect_timeout: 60
```

AgentConnect requirements:

- Set `MCP_HTTP_ENABLED=true` to expose `/mcp`.
- Keep the endpoint on TLS and private ingress or strict edge auth.
- Use a service key by default.
- Use a root key only for root-only MCP operations such as `agentinfra.payments.create_card_details_session`.
- Payment MCP tools appear only when the Stripe adapter is configured.

### Supported tool classes

The MCP surface should stay aligned with existing routes, not invent new semantics:

- Bootstrap: org creation and service-key creation
- Agents: create, list, get, update, archive
- Resources: create, list, delete
- Email: send, reply, get message
- Payments: issue card, create card details session (root only), when Stripe is configured
- Observability: list events, list timeline

### Hermes conformance gate

Phase E is not done until `tests/hermes-mcp.integration.ts` proves all of the following:

1. `tools/list` over HTTP returns bootstrap-only tools when unauthenticated.
2. A service key sees the expected scoped tools and does not see root-only tools.
3. A root key sees the root-only tools.
4. Hermes-style tool discovery works with the expected `mcp_agentconnect_agentinfra_*` prefixing.
5. End-to-end operations succeed through MCP for:
   - `agents.create`
   - `resources.create`
   - `email.send`
   - `email.reply`
   - `events.list`
   - `timeline.list`
   - `payments.issue_card`
6. Typed API failures still surface as typed MCP failures.
7. After a forced MCP disconnect or server restart, Hermes reconnects and the same operations still succeed.

## OpenClaw Integration

### Official contract

OpenClaw exposes two relevant official surfaces:

- Gateway/operator HTTP APIs, including `POST /v1/responses`, authenticated with `Authorization: Bearer <GATEWAY_TOKEN>`
- Hooks such as `POST /hooks/agent` and `POST /hooks/wake`, authenticated with either `Authorization: Bearer <TOKEN>` or `x-openclaw-token: <TOKEN>`

OpenClaw hook configuration also supports routing constraints such as:

- `allowedAgentIds`
- `allowRequestSessionKey`
- `allowedSessionKeyPrefixes`

### MVP integration decision

Use the official surfaces in the direction they are intended:

- OpenClaw -> AgentConnect: OpenClaw workflows or tools call AgentConnect's REST APIs directly.
- AgentConnect -> OpenClaw: AgentConnect outbound webhook subscriptions deliver into OpenClaw hook endpoints.

Do not use OpenClaw's operator-grade `POST /v1/responses` endpoint as AgentConnect's event callback target. For event-driven wakeups, hooks are the correct official surface.

### AgentConnect mapping

Current REST calls from OpenClaw workflows map cleanly to AgentConnect:

- Agent provisioning: `POST /agents`
- Resource provisioning: `POST /agents/:id/resources`
- Email actions: `POST /agents/:id/actions/send_email`, `POST /agents/:id/actions/reply_email`
- Card issuance: `POST /agents/:id/actions/issue_card`
- Observability: `GET /agents/:id/events`, `GET /agents/:id/timeline`
- Key lifecycle: `POST /orgs/:id/api-keys`, `POST /orgs/:id/api-keys/rotate-root`, `POST /orgs/:id/api-keys/:keyId/revoke`
- Billing: `POST /billing/checkout`, `POST /billing/portal`

Operational notes for workflow authors:

- Email send and reply routes require a non-empty `idempotency_key`. Reuse the same key when retrying the same action.
- Billing and API key lifecycle routes are root-key only.
- Payment routes and MCP payment tools are unavailable when Stripe is not configured.

Direct AgentConnect -> OpenClaw delivery is exposed as root-key managed outbound subscriptions:

- `POST /webhook-subscriptions`
- `GET /webhook-subscriptions/:id/deliveries`

Implemented delivery behavior:

- `delivery_mode` is bounded to `canonical_event`, `openclaw_hook_agent`, and `openclaw_hook_wake`
- Static outbound auth headers are bounded to `Authorization` and `x-openclaw-token`
- OpenClaw modes support the official hook contracts under the configured OpenClaw hook base path:
  - `openclaw_hook_agent` -> default example `POST /hooks/agent`
  - `openclaw_hook_wake` -> default example `POST /hooks/wake`
- Mapped hooks such as `POST /hooks/<name>` remain unsupported
- Deliveries are deduped on `(subscription_id, event_id)`
- Worker retries transient `401`, `429`, network, and `5xx` failures with exponential backoff plus jitter, and honors `Retry-After` on `429` when present
- Delivery-time DNS revalidation fails closed for local/private targets and retries transient DNS resolution failures before marking the attempt failed
- Stable `400` payload failures are recorded and not retried forever
- Every delivery carries `x-agentconnect-*` metadata headers plus an HMAC signature over `${timestamp}.${body}`

Recommended OpenClaw deployment settings:

- Keep the hook endpoint on private ingress or behind strict edge auth
- Use a dedicated hook token per subscription
- Prefer gateway-side `allowedAgentIds`
- Leave `allowRequestSessionKey=false` unless the subscription uses `delivery_config.session_key_prefix`
- If you enable per-event `sessionKey`, scope OpenClaw with `allowedSessionKeyPrefixes` that match the configured prefix

Example subscription targeting the default `POST /hooks/agent` path:

```json
{
  "url": "https://openclaw.example.com/hooks/agent",
  "event_types": ["email.received", "payment.card.settled"],
  "delivery_mode": "openclaw_hook_agent",
  "static_headers": {
    "authorization": "Bearer oc_hook_token"
  },
  "delivery_config": {
    "agent_id": "assistant_ops",
    "session_key_prefix": "agentconnect_evt_"
  }
}
```

`openclaw_hook_agent` sends the official OpenClaw body fields and places the canonical event envelope in the `message` string. `openclaw_hook_wake` does the same with the `text` field for wake-only semantics.

If your OpenClaw deployment changes the hook base path, keep the same official agent/wake contract and swap in the configured base path. For example, `/internal/openclaw/agent` is valid for `openclaw_hook_agent` if that deployment exposes the official agent hook there.

### OpenClaw conformance gate

Phase E is not done until `tests/openclaw-hooks.integration.ts` proves all of the following:

1. AgentConnect can authenticate to OpenClaw hooks with either `Authorization: Bearer` or `x-openclaw-token`.
2. `openclaw_hook_agent` delivery mode produces the expected hook body shape from a canonical event.
3. `openclaw_hook_wake` delivery mode does the same when wake-only semantics are desired.
4. Deliveries are deduped on repeated worker replays for the same `(subscription_id, event_id)`.
5. Retries occur for transient `401`, `429`, `5xx`, and transient DNS resolution failures according to the worker backoff policy, and `429` honors `Retry-After` when present.
6. Stable `400` payload failures are recorded and not retried forever.
7. Subscription docs and examples default to private ingress, dedicated hook tokens, `allowedAgentIds`, and restricted `allowedSessionKeyPrefixes`.

## Release Gate

Before claiming Hermes/OpenClaw production support:

1. Run `pnpm run verify`.
2. Run the dedicated conformance suites:
   - `tests/hermes-mcp.integration.ts`
   - `tests/openclaw-hooks.integration.ts`
3. Run a staging smoke with a real Hermes config against hosted `/mcp`.
4. Run a staging smoke against a real OpenClaw hook endpoint.
5. If card tooling is enabled, run the optional live Stripe smoke before rollout.

## Current Gaps

These are the remaining gaps relative to the target above:

- Hermes transport and tool surface now have an explicit real-client conformance suite, but hosted staging smoke against `/mcp` is still required before any production-ready claim.
- Direct AgentConnect -> OpenClaw hook delivery is implemented and covered by `tests/openclaw-hooks.integration.ts`, but a real staging smoke against an OpenClaw deployment is still required before any production-ready claim.
- API key expiry/spend bounds/allowed actions, per-key rate limiting, and HMAC request signing remain Phase E3 hardening work.
