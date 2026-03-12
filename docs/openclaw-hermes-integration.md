# OpenClaw and Hermes Integration Guide

This guide defines the strict integration target for AgentConnect Phase E. We only call an integration "supported" when the codebase passes the conformance and reliability checks described here.

Official references used for this guide:

- OpenClaw docs: <https://docs.openclaw.ai/>
- Hermes Agent docs: <https://hermes-agent.nousresearch.com/docs/>

## Executive Summary

| Direction                | Official surface                                                                                           | AgentConnect decision                                                                                                 | Status                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Hermes -> AgentConnect   | Remote MCP server via `mcp_servers` with `url`, `headers`, `timeout`, `connect_timeout`                    | Support directly via hosted HTTP `/mcp` and local stdio MCP. Keep MCP as a thin facade over existing routes/services. | Partial: transport exists; strict Hermes conformance gate still required |
| OpenClaw -> AgentConnect | OpenClaw operator workflows over authenticated Gateway HTTP calls                                          | OpenClaw workflows call AgentConnect REST APIs with stable idempotency keys.                                          | Supported now                                                            |
| AgentConnect -> OpenClaw | OpenClaw hooks (`POST /hooks/agent`, `POST /hooks/wake`) with dedicated hook auth and routing restrictions | Phase E2 adds outbound auth-header support plus bounded OpenClaw delivery modes. No generic workflow engine.          | Not complete yet                                                         |

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

### Supported tool classes

The MCP surface should stay aligned with existing routes, not invent new semantics:

- Bootstrap: org creation and service-key creation
- Agents: create, list, get, update, archive
- Resources: create, list, delete
- Email: send, reply, get message
- Payments: issue card, create card details session (root only)
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

To support direct AgentConnect -> OpenClaw delivery in Phase E2, outbound subscriptions need:

- Static outbound auth headers so requests can include either `Authorization: Bearer ...` or `x-openclaw-token: ...`
- A bounded `delivery_mode` enum
- At least one OpenClaw hook envelope format
- Delivery dedupe on `(subscription_id, event_id)`
- Retry semantics that treat transient auth/rate-limit/server failures differently from stable payload failures

### OpenClaw conformance gate

Phase E is not done until `tests/openclaw-hooks.integration.ts` proves all of the following:

1. AgentConnect can authenticate to OpenClaw hooks with either `Authorization: Bearer` or `x-openclaw-token`.
2. `openclaw_hook_agent` delivery mode produces the expected hook body shape from a canonical event.
3. `openclaw_hook_wake` delivery mode does the same when wake-only semantics are desired.
4. Deliveries are deduped on repeated worker replays for the same `(subscription_id, event_id)`.
5. Retries occur for transient `401`, `429`, and `5xx` responses according to the worker backoff policy.
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

- Hermes transport and tool surface exist, but the explicit Hermes-branded conformance suite is not yet part of the release gate.
- Direct AgentConnect -> OpenClaw hook delivery still needs outbound auth-header support and bounded OpenClaw delivery modes.
- API key expiry/spend bounds/allowed actions, per-key rate limiting, and HMAC request signing remain Phase E3 hardening work.
