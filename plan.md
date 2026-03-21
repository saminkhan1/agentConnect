# System Architecture (MVP that scales)

## Full Project

**What we’re building:** A unified control plane + event log that lets AI agents send and receive emails, send and receive payments — exactly how humans currently behave — with safe tool/MCP access and a per-agent timeline. Later: SMS and voice.

**Who it’s for:** First wedge = personal AI users and prosumers who want managed, fast, safe access to real-world capabilities for their agent. Expansion = power users, small teams, startups (see `business-plan.md` for full go-to-market).

**Why now / why we win:** Email-for-agents (AgentMail), card-for-agents (CardForAgent, Slash), and protocols like MCP and MPP are maturing, but they’re all separate silos. CardForAgent does cards only. Slash does cards + payments only. AgentMail does email only. Nobody unifies email + payments under one agent identity with policy, observability, and audit across all rails. We win by being the only product where one `agent_id` can send an email, buy something with a virtual card, receive a payment, and have the full activity timeline in one place.

**Protocol strategy:** Three layers, adopted incrementally:
- **MCP** — tool/capability transport (Phase E, in progress)
- **Agent Auth Protocol** (agent-auth-protocol.com) — per-agent cryptographic identity, scoped capability grants, independent lifecycle. Replaces coarse API keys with fine-grained agent-level auth. Adopt after billing ships (Phase H).
- **MPP** (mpp.dev, co-authored by Stripe + Tempo, launched March 2026) — HTTP 402-based machine-to-machine payments. Enables agents with our Stripe Issuing cards to pay for any MPP-enabled service on the open web via Shared Payment Tokens. Adopt when ecosystem matures (Phase I).

## MVP

Single codebase, 2 process types (low cost, easy scaling). Ship one Node/TS repo + one container image, but run it as:

- **API process:** REST + inbound webhooks (+ later MCP)
- **Worker process:** async jobs (outbound webhook delivery, retries, backfills — partially built in Phase E)

This keeps MVP infra minimal (often Postgres-only) while giving you a clean scaling path:

- More API replicas for request throughput
- More worker replicas for webhook spikes / outbound webhook retries
- No need to split repos/services until you actually hit real constraints

### Postgres-first to keep infra cost low

- **Postgres:** source of truth + event log + job queue (Graphile Worker / pg-boss)
- **Redis:** optional later for higher-fidelity rate limiting / caching (start without)

### Webhook ingestion = fast ACK, async processing

Inbound provider webhooks should:

1. Verify signature
2. Enqueue job with raw payload + provider metadata
3. Return 2xx quickly

This protects you from provider retries and allows backpressure control.

### Provider integration model (maintainable + safe)

All providers integrate through a single adapter surface:

- Actions (send email, issue card) are synchronous APIs, but each call should also emit events or schedule a reconciliation job.
- Webhooks are the authoritative event stream; you map provider-specific events to canonical event types and write via `EventWriter` with idempotency.

### Voice latency (future-proofing now, without shipping voice)

Even if voice is deferred, design now for low-latency paths:

- Create a concept of a Realtime Webhook handler (must respond within provider SLA) vs. Async Webhook handler (can enqueue).
- For voice in the future, keep “call control decisioning” synchronous and minimal, and everything else async. This is how you avoid latency explosions when you add policy/LLM checks later.

## Repo & Branch Strategy

- **Trunk:** `main` — always deployable, protected, requires PR + CI pass (solo dev: self-review).
- **Branch naming:**
  - `feat/<phase>/<description>` — new functionality
  - `fix/<description>` — bug fixes
  - `chore/<description>` — tooling, CI, docs
  - `refactor/<description>` — structural changes with no behavior change
- **PR rules:** squash-merge into main. Each PR maps to one logical unit below. Tag milestones with `v0.1.0`, `v0.2.0`, etc.

## Core Design Decisions (lock these before coding)

### Canonical entities

- `orgs` → owns everything
- `api_keys` → root + service (MVP); later complemented by Agent Auth per-agent identity (Phase H)
- `agents` → canonical `agent_id`
- `resources` → “capabilities” attached to an agent (inbox, card; later payment_account in Phase I)
- `events` → immutable canonical log (the product)
- `outbound_actions` → idempotent outbound operations (send_email, reply_email; added Phase E)
- `webhook_subscriptions` + `webhook_deliveries` → outbound webhook fanout (added Phase E)

### Event idempotency strategy (provider-friendly)

Use two layers:

1. **Provider idempotency** when ingesting webhooks: unique on `(org_id, provider, provider_event_id)` when available.
2. **Client idempotency** for your own write APIs (actions): optional `idempotency_key` unique per org.

### Multi-tenancy guardrails

- Every table includes `org_id`
- Every query is scoped by `org_id` in the DAL
- (Later) optional Postgres Row Level Security (RLS) once you have multiple services / internal tooling

### Sensitive payments data rule (MVP must)

- **Never persist PAN/CVV (not in DB, not in logs).**
- Return card details once at issuance; store only masked/token references + provider refs.
- Add log redaction utilities before you integrate card issuance.

## Phase A — MVP Scaffold + Auth + Agents (Week 1)

**Goal:** A single deployable service with org-scoped auth, agent registry, and a clean internal architecture for growth.
**Branch:** `feat/phaseA/scaffold-auth-agents`

| Commit                                        | What                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init: monorepo scaffold with domain modules` | Top-level dirs: `src/api/`, `src/domain/`, `src/adapters/`, `src/jobs/`, `src/db/`, `tests/`, `docs/`. Keep as modules, not separately deployed services (yet). |
| `chore: strict tsconfig + lint + format`      | Strict TS, eslint, prettier. Add typecheck, lint, test scripts.                                                                                                 |
| `chore: docker compose for local dev`         | Postgres 16 only. Add optional Redis service commented out (document why).                                                                                      |
| `feat: app entrypoint + health + request ids` | Fastify + `GET /health`. Add correlation/request ID middleware.                                                                                                 |
| `chore: migrations + db access layer`         | Choose one (Drizzle/Prisma/node-pg-migrate). Implement a DAL pattern that requires `org_id` for all reads/writes.                                               |
| `migration: orgs + api_keys + agents`         | `orgs`, `api_keys(key_type: root \| service)`, `agents`.                                                                                                        |
| `feat: org + api key endpoints`               | `POST /orgs` creates org + returns root key once. `POST /orgs/:id/api-keys` creates service keys. Hash keys at rest.                                            |
| `feat: auth middleware + scope helper`        | Resolve `Authorization: Bearer sk_...` → `{ org_id, key_id, scopes }`. `requireScope()` helper.                                                                 |
| `feat: agent CRUD`                            | `POST /agents`, `GET /agents`, `GET /agents/:id`, `PATCH`, `DELETE` (soft archive).                                                                             |
| `test: auth + agent e2e`                      | Valid/invalid/revoked keys, cross-org isolation.                                                                                                                |
| `chore: CI pipeline`                          | Lint, typecheck, test, build on PR.                                                                                                                             |

**PR → main:** “Phase A: scaffold + auth + agents (single deployable)”
**Tag:** `v0.1.0`

## Phase B — Canonical Event Log + Events API (Week 2)

**Goal:** Events are the product. Ship the event log + query surface before timelines/projectors.
**Branch:** `feat/phaseB/event-log`

| Commit                                                    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migration: create events table`                          | `events(id UUID, org_id, agent_id, resource_id?, provider text, provider_event_id text, event_type text, occurred_at timestamptz, idempotency_key text, data JSONB, ingested_at timestamptz default now())` with unique constraints: `(org_id, provider, provider_event_id)` partial where `provider_event_id` not null; `(org_id, idempotency_key)` partial where `idempotency_key` not null. Indexes: `(org_id, agent_id, occurred_at desc)`, `(org_id, event_type, occurred_at desc)`. |
| `feat: canonical event registry`                          | `const EVENT_TYPES = {...}` + runtime validator. Start with email + card only.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `feat: EventWriter service`                               | `writeEvent({orgId, agentId, ...})` handles upsert/conflict, consistent timestamps, and standard metadata fields (idempotent).                                                                                                                                                                                                                                                                                                                                                            |
| `feat: GET /agents/:id/events`                            | Filters: type, since, until, limit, cursor. Always scoped by org.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `feat: internal event ingestion helpers`                  | `ingestProviderEvents(provider, events[])` to normalize + batch-write safely.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test: EventWriter idempotency + events query pagination` | Insert duplicates via `provider_event_id` and via `idempotency_key`. Cursor paging correctness.                                                                                                                                                                                                                                                                                                                                                                                           |

**PR → main:** “Phase B: event log + events API”
**Tag:** `v0.2.0`

## Phase C — Resource Manager + Email Adapter + Config-based Policies (Weeks 3–4)

**Goal:** Provision inbox, send email, ingest provider webhooks, emit canonical events. Policies are simple per-resource config (no generic engine yet).

### Branch: `feat/phaseC/resources-core`

| Commit                              | What                                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migration: create resources table` | `resources(id, org_id, agent_id, type enum(email_inbox, card), provider text, provider_ref text, config JSONB, state enum(provisioning, active, suspended, deleted), created_at, updated_at)` unique `(org_id, provider, provider_ref)` when `provider_ref` not null. |
| `feat: ProviderAdapter interface`   | `provision()`, `deprovision()`, `performAction()`, `verifyWebhook()`, `parseWebhook()` (returns canonical events + optional `resourceRef`).                                                                                                                           |
| `feat: ResourceManager`             | Provision/deprovision wrappers, state transitions, stores provider refs + config, emits resource lifecycle events (optional).                                                                                                                                         |
| `feat: resource endpoints`          | `POST /agents/:id/resources` (email_inbox first), `GET /agents/:id/resources`, `DELETE /agents/:id/resources/:rid`.                                                                                                                                                   |
| `feat: config-based policy helpers` | `enforceEmailPolicy(resource.config, payload)` supports `allowed_domains`, `blocked_domains`, `max_recipients`. Return `{allowed, reasons[]}`.                                                                                                                        |
| `test: resources e2e`               | Provision mocked adapter, persist state, enforce org scoping.                                                                                                                                                                                                         |

**PR → main:** “Phase C1: resource manager + config policies”

### Branch: `feat/phaseC/email-adapter`

> **Provider:** AgentMail — uses Svix for webhook delivery. SDK: `@agentmail/client` (TS) or `agentmail` (Python).

| Commit                                                     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feat: AgentMailAdapter provision + deprovision`           | Call `client.inboxes.create()`. The response `inbox_id` **is** the full email address (e.g., `agent123@agentmail.to`). Store it as `provider_ref` on the resource row. Deprovision calls `client.inboxes.delete(inboxId)`.                                                                                                                                                                                                                                                                                         |
| `feat: POST /agents/:id/actions/send_email`                | Lookup email resource → `enforceEmailPolicy` → call `client.inboxes.messages.send(resource.provider_ref, { to, subject, text, html?, cc?, bcc?, reply_to?: single address or address array })` (TS SDK: `inbox_id` is positional first arg, remaining fields are the second object arg). Emit `email.sent` event with idempotency via action `idempotency_key`.                                                                                                                                                    |
| `feat: inbound webhook endpoint`                           | `POST /webhooks/agentmail` — **Expose raw body buffer** (do not parse JSON before verification). Verify using the Svix library: `new Webhook(secret).verify(rawBody, headers)` where headers must include `svix-id`, `svix-timestamp`, and `svix-signature`. On success, enqueue raw payload + headers for async processing and return `200` immediately.                                                                                                                                                          |
| `feat: webhook job processor (email)`                      | AgentMail webhook payloads are event-specific. `message.received` carries a `message` object whose `message.inbox_id` maps to `provider_ref`; `message.sent`, `message.delivered`, `message.bounced`, `message.complained`, and `message.rejected` use `send`, `delivery`, `bounce`, `complaint`, and `reject` objects respectively. Map `event_id` → `provider_event_id` for deduplication, then extract `message_id`, `thread_id`, timestamp, recipients, and reason/type fields from the event-specific object. |
| `feat: provider client wrapper`                            | Timeouts, retries with jitter for outbound API calls; circuit-breaker hooks (lightweight).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `test: email send + webhook ingestion e2e (mock provider)` | Mock AgentMail API + generate Svix-signed webhook payloads (use test secret + Svix test helper). Assert canonical events written to DB with correct `provider_event_id`, `thread_id`, and `from` field.                                                                                                                                                                                                                                                                                                            |
| `docs: provider integration contract`                      | Document AgentMail webhook payload fields depended on: `event_id` (dedup key), `event_type`, `message.thread_id`, `message.message_id`, `message.from`, `message.timestamp`. Note all 6 canonical email event types supported.                                                                                                                                                                                                                                                                                     |

**PR → main:** “Phase C2: email end-to-end (resource + action + webhooks)”
**Tag:** `v0.3.0`

## Phase D — Card Adapter + Minimal Timeline View (Weeks 5–6)

**Goal:** Issue temp virtual card + ingest auth/transaction webhooks + show unified activity via a thin timeline API derived from events.

### Branch: `feat/phaseD/card-adapter`

> **Provider:** Stripe Issuing — uses `stripe-signature` header + `stripe.webhooks.constructEvent` for verification.

| Commit                                                        | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat: CardAdapter provision (issue card resource)`           | **Step 1 — Cardholder:** Call `stripe.issuing.cardholders.create({ name: agent.name, type: 'individual', billing: { address: { line1, city, postal_code, country } } })`. All four fields (`name`, `type`, `billing.address.*`) are required by Stripe API. Note: `'company'` type has availability restrictions depending on Stripe's review; default to `'individual'`. **Step 2 — Card:** Call `stripe.issuing.cards.create({ cardholder: cardholder.id, type: 'virtual', currency: 'usd', spending_controls: { spending_limits: [{ amount, interval }], allowed_categories?, allowed_merchant_countries? } })`. Store the returned card `id` (format `ic_...`) as `provider_ref`. Store cardholder id in resource `config`. |
| `feat: POST /agents/:id/actions/issue_card`                   | Creates card via CardAdapter; returns PAN/exp/CVV **once only** (from `card.number`, `card.cvc`, `card.exp_month/year`); **redact all sensitive fields from logs before returning**; store only last-4 + `provider_ref` (`ic_...`). Emits `payment.card.issued` event.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `feat: inbound webhook endpoint`                              | `POST /webhooks/stripe` — **Expose raw body buffer** (do not parse JSON before verification). Verify with `stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], endpointSecret)`. On success, enqueue raw payload + event type and return `200` immediately.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `feat: webhook job processor (card)`                          | Use Stripe's `event.id` (format `evt_...`) as `provider_event_id` for idempotency. Mappings: **`issuing_authorization.created`** → inspect `event.data.object.approved` boolean: `true` → emit `payment.card.authorized`, `false` → emit `payment.card.declined` (this single event type fires for both outcomes). **`issuing_transaction.created`** → emit `payment.card.settled` (Stripe "transactions" = captures/settlements). Note: do not rely on `approved` alone for integration health — Stripe Autopilot can approve on your behalf during error conditions.                                                                                                                                                          |
| `feat: config enforcement for issuance`                       | Use Stripe's native `spending_controls` at card-creation time: `spending_limits[].amount` (integer in smallest currency unit), `spending_limits[].interval` (`per_authorization` \| `daily` \| `weekly` \| `monthly`), `allowed_categories` (MCC codes), `allowed_merchant_countries`. Hard platform limits: max 10,000 USD per authorization; aggregation has ~30s delay so real-time enforcement is not reliable at MVP. Defer `issuing_authorization.request` real-time decisioning to vNext.                                                                                                                                                                                                                                |
| `test: card issuance + webhook ingestion e2e (mock provider)` | Assert no PAN/CVV stored or logged. Assert `ic_...` stored as `provider_ref`. Construct mock Stripe webhook events (signed with test secret), assert `payment.card.authorized`, `payment.card.declined`, and `payment.card.settled` events written with correct `provider_event_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**PR → main:** “Phase D1: card issuance + events”

### Branch: `feat/phaseD/timeline-derived`

| Commit                                     | What                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat: GET /agents/:id/timeline (derived)` | Compute “items” on read by grouping recent events by coarse keys: email by `thread_id` (from event data), card by `transaction_id` or `authorization_id`. Cursor-based paging by `occurred_at`. |
| `feat: timeline item shape + serializers`  | Keep stable response schema so later you can swap to projected tables without breaking clients.                                                                                                 |
| `test: timeline grouping e2e`              | Two emails same thread → one item. Auth+settle pair → one “purchase” item.                                                                                                                      |
| `docs: upgrade path to projected timeline` | Explain when to add `timeline_items` tables + projector worker (volume/latency threshold).                                                                                                      |

**PR → main:** “Phase D2: derived timeline API (no projector yet)”
**Tag:** `v0.4.0` — MVP “wow loop” complete.

## Phase E — MCP + Outbound Webhooks (Weeks 7–8)

**Goal:** Ship the official orchestrator integration paths without creating a second architecture: Hermes connects over standard MCP, OpenClaw consumes canonical events via its official hook surfaces, and we do not claim production readiness until those paths pass explicit conformance + reliability gates.

### Phase E guardrails

- Keep the lean MVP shape: one codebase, one image, API + Worker only. No orchestrator-specific sidecar service.
- MCP stays a thin transport over existing Fastify routes/domain services. No duplicate business logic for tool calls.
- Outbound webhook fanout stays async in the Worker and Postgres-backed queue path. API request paths remain fast-ACK.
- Add only bounded compatibility needed by official docs: scoped MCP auth, outbound auth headers, and a small set of delivery modes. Do **not** build a general transformation/workflow engine in MVP.
- Do not mark Hermes/OpenClaw support as “production ready” in README/docs until the suites below pass in CI and in a staging smoke run.

### Branch: `feat/phaseE/mcp-gateway`

| Commit                                         | What                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat: MCP server module (thin facade)`        | Expose the existing bootstrap + scoped agent/resource/email/payment/event/timeline capabilities through MCP. Root-only tools (for example `agentinfra.payments.create_card_details_session`) stay hidden unless the session is authenticated with a root key.                                           |
| `feat: MCP auth + transport boundaries`        | Support both stdio and HTTP `/mcp`; Bearer API key resolves org + scopes; `tools/list` reflects scope + key type; unauthenticated sessions expose bootstrap-only tools.                                                                                                                                 |
| `feat: call_tool dispatch`                     | Map tools → internal REST handlers/services via Fastify inject so MCP cannot drift from the core API behavior.                                                                                                                                                                                          |
| `docs: Hermes + generic MCP integration guide` | Hermes `mcp_servers` examples (`url`, `headers`, `timeout`, `connect_timeout`), Claude Desktop/Cursor examples, service-vs-root key guidance, and failure-mode notes.                                                                                                                                   |
| `test: MCP protocol conformance e2e`           | Cover `initialize`, `tools/list`, `tools/call`, auth failures, CORS/HTTP transport, root-only tool hiding, and typed error envelopes.                                                                                                                                                                   |
| `test: Hermes agent compatibility suite`       | Add `tests/hermes-mcp.integration.ts` to drive a Hermes-style remote MCP config against `/mcp`, verify reconnect after disconnect, prefixed tool discovery, and end-to-end `agents.create`, `resources.create`, `email.send`, `email.reply`, `events.list`, `timeline.list`, and `payments.issue_card`. |

**PR → main:** “Phase E1: MCP gateway + Hermes conformance”

### Branch: `feat/phaseE/outbound-webhooks`

| Commit                                                       | What                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `migration: create webhook_subscriptions + deliveries`       | `webhook_subscriptions(id, org_id, url, event_types[], delivery_mode, signing_secret, static_headers, status, created_at)` and `webhook_deliveries(id, subscription_id, event_id, attempt_count, last_status, next_attempt_at, created_at, updated_at)`. Add unique dedupe on `(subscription_id, event_id)`. |
| `feat: POST /webhook-subscriptions`                          | Create subscription + generate secret; validate URL allowlist (basic SSRF guard); allow a bounded `delivery_mode` enum and allowlisted static outbound auth headers so AgentConnect can authenticate to official OpenClaw hook endpoints.                                                                    |
| `feat: delivery worker (retries + bounded payload adapters)` | Worker picks new events → fanout to subs → HMAC signature for canonical payloads → apply delivery mode mapping → send auth headers → 3 retries with exponential backoff + jitter. Keep mappings intentionally small (`canonical_event` default, `openclaw_hook_agent`/`openclaw_hook_wake` only if needed).  |
| `feat: GET /webhook-subscriptions/:id/deliveries`            | Debug recent failures/success with enough request/response metadata to triage auth and payload mismatches safely.                                                                                                                                                                                            |
| `docs: OpenClaw webhook integration guide`                   | Document direct delivery to `POST /hooks/agent` / `POST /hooks/wake`, dedicated hook tokens, `allowedAgentIds`, `allowedSessionKeyPrefixes`, and when to keep `allowRequestSessionKey=false`.                                                                                                                |
| `test: outbound delivery + retry`                            | Fake endpoint, assert retries, no duplicate fanout for the same `(subscription_id, event_id)`, and final status accounting.                                                                                                                                                                                  |
| `test: OpenClaw hook compatibility suite`                    | Add `tests/openclaw-hooks.integration.ts` to verify AgentConnect can deliver to OpenClaw hooks with `Authorization: Bearer` or `x-openclaw-token`, expected body shape, correct retry handling for `401`/`429`/transient `5xx`, and no retries for stable `400` payload failures.                            |

**PR → main:** “Phase E2: outbound webhooks + OpenClaw hook conformance”
**Tag:** `v0.5.0` — orchestrator-ready MVP (`Hermes MCP` + `OpenClaw hooks`) verified on the lean architecture.

### Branch: `feat/phaseE/auth-hardening`

> **Context:** Borrowing security patterns from ERC-8118 (bounded authorization) and ERC-8128 (HTTP request signing) without on-chain dependencies. These harden the existing API key model for agent-facing production use.

| Commit                                                 | What                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migration: add key expiry + spend limits to api_keys` | Add `expires_at TIMESTAMPTZ` (nullable — null = no expiry), `max_spend_cents INTEGER` (nullable — null = unlimited), `allowed_actions TEXT[]` (nullable — null = all actions) to `api_keys`. These implement ERC-8118-style bounded authorization without smart contracts.        |
| `feat: enforce key expiry + bounds in auth middleware` | Auth plugin checks `expires_at` (reject with `UNAUTHENTICATED` + clear message if expired). `requireScope()` extended to also check `allowed_actions` when present. Spend tracking via lightweight counter query on `events` table filtered by key's agent actions.               |
| `feat: per-key rate limiting (in-memory token bucket)` | Simple token-bucket rate limiter keyed on `key_id`. Default: 100 req/15 min (configurable per key via `api_keys.config` JSONB). Returns `429` with `Retry-After` header. Protects against agent loops (OpenClaw cron polling, Hermes sub-agent swarms). Redis upgrade path later. |
| `feat: HMAC request signing (optional auth mode)`      | Support `Authorization: HMAC <keyId>:<signature>` alongside existing Bearer tokens. Signature = HMAC-SHA256 of `method + path + timestamp + SHA256(body)` using the key secret. Verifies timestamp within ±5 min to prevent replay. Secret never travels over the wire.           |
| `feat: GET /.well-known/agent.json (A2A Agent Card)`   | Static JSON route exposing AgentConnect capabilities, supported auth schemes, and skill descriptions. Makes the platform discoverable by A2A-compatible agents without requiring manual directory lookups.                                                                        |
| `test: expired key + rate limit + HMAC signing e2e`    | Assert expired keys rejected, rate limit returns 429, HMAC auth succeeds/fails correctly, agent.json schema valid.                                                                                                                                                                |

**PR → main:** "Phase E3: auth hardening + agent discoverability"
**Tag:** `v0.5.1`

## Phase F — Billing + Quota Infrastructure (Weeks 9–10)

**Goal:** Make the system actually charge customers money. Add plan tiers that gate features, usage counters that enforce limits, and Stripe Billing that collects subscription payments. Without this phase the product has no revenue path.

### Phase F1: Plan tiers + usage accounting

**Branch:** `feat/phaseF/plan-tiers`

| Commit                                                     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migration: add plan_tier + stripe billing fields to orgs` | Add `plan_tier enum('starter','personal','actions_beta','power_user','team_starter','growth') NOT NULL DEFAULT 'starter'`, `stripe_customer_id TEXT`, `stripe_subscription_id TEXT`, `subscription_status TEXT`, `current_period_end TIMESTAMPTZ` to `orgs`.                                                                                                                                                                                                                  |
| `migration: create usage_counters table`                   | `usage_counters(id, org_id, period_start DATE, emails_sent INT NOT NULL DEFAULT 0, inboxes_active INT NOT NULL DEFAULT 0, cards_active INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ)` unique on `(org_id, period_start)`. Upsert on each action; period_start = first day of current billing month.                                                                                                                                                                         |
| `feat: PLAN_LIMITS config`                                 | Define per-tier limits in `src/domain/billing-limits.ts`: `{ max_inboxes, monthly_emails, cards_allowed: boolean }` for each tier. Starter = 1 inbox / 1,000 emails / no cards. Personal = 1 inbox / 2,000 emails / no cards. Actions Beta = 1 inbox / 2,000 emails / cards allowed. Power User = 3 inboxes / 10,000 emails / cards allowed. Team Starter = 10 inboxes / 25,000 emails / cards allowed.                                                                       |
| `feat: quota enforcement in ResourceManager`               | Before calling adapter in `provision()`, load current `usage_counters` for this org+period. If provisioning `email_inbox` and `inboxes_active >= plan.max_inboxes`, throw `PolicyError('QUOTA_EXCEEDED', { limit: plan.max_inboxes, current: ... })` with HTTP 422. If provisioning `card` and `!plan.cards_allowed`, throw `PolicyError('CARD_ACCESS_PLAN_REQUIRED')`. Increment `inboxes_active` or `cards_active` counter atomically on success. Decrement on deprovision. |
| `feat: email volume quota in outbound-actions`             | In `dispatchSendEmail()`, load usage_counters and check `emails_sent < plan.monthly_emails` before dispatch. Increment `emails_sent` atomically on success. Return `PolicyError('EMAIL_QUOTA_EXCEEDED')` if over limit.                                                                                                                                                                                                                                                       |
| `feat: GET /billing/usage`                                 | Returns `{ plan_tier, period_start, usage: { emails_sent, monthly_email_limit, inboxes_active, max_inboxes, cards_active }, subscription_status, current_period_end }`. Scoped to authenticated org.                                                                                                                                                                                                                                                                          |
| `test: plan tier quota enforcement`                        | Assert Starter org cannot provision a second inbox (422). Assert Starter org cannot provision a card (403/422). Assert Actions Beta org can provision a card. Assert email quota blocks dispatch at limit. Assert usage counters increment correctly.                                                                                                                                                                                                                         |

**PR → main:** "Phase F1: plan tiers + usage accounting"

### Phase F2: Stripe Billing integration

**Branch:** `feat/phaseF/stripe-billing`

> Stripe Billing is a completely separate Stripe product from Stripe Issuing. These use the same Stripe secret key but different API namespaces (`stripe.checkout`, `stripe.billingPortal`, `stripe.subscriptions`).

| Commit                                                                  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat: BillingService`                                                  | New `src/domain/billing.ts`. Methods: `getOrCreateCustomer(orgId, email)` — upserts Stripe customer, stores `stripe_customer_id` on org. `createCheckoutSession(orgId, priceId, successUrl, cancelUrl)` — creates hosted Checkout session. `createPortalSession(orgId, returnUrl)` — creates Customer Portal session. `syncSubscription(event)` — processes billing webhook events and updates org `plan_tier` + `subscription_status`.                                                                                                                   |
| `feat: POST /billing/checkout`                                          | Body: `{ plan_tier, success_url, cancel_url }`. Looks up `STRIPE_PRICE_IDS[plan_tier]` from env config. Calls `BillingService.createCheckoutSession()`. Returns `{ url }`. Root API key required.                                                                                                                                                                                                                                                                                                                                                         |
| `feat: GET /billing/portal`                                             | Calls `BillingService.createPortalSession()`. Returns `{ url }`. Requires existing `stripe_subscription_id` on org. Root API key required.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `feat: POST /webhooks/stripe-billing`                                   | Separate route from `/webhooks/stripe` (which handles Issuing). Verifies signature using `STRIPE_BILLING_WEBHOOK_SECRET`. Handles: `checkout.session.completed` → call `getOrCreateCustomer`, set `stripe_subscription_id` + `plan_tier` from metadata; `customer.subscription.updated` → update `plan_tier` (from price ID lookup) + `subscription_status` + `current_period_end`; `customer.subscription.deleted` → set `plan_tier = 'starter'`, `subscription_status = 'canceled'`; `invoice.payment_failed` → set `subscription_status = 'past_due'`. |
| `chore: add STRIPE_BILLING_WEBHOOK_SECRET + STRIPE_PRICE_IDS to config` | Add to `src/config.ts` Zod config and `.env` docs. `STRIPE_PRICE_IDS` = JSON map of plan tier → Stripe price ID.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test: billing webhooks`                                                | Simulate each webhook event type with valid Stripe signature. Assert `plan_tier` and `subscription_status` update correctly in DB. Assert downgrade to starter on subscription deletion. Assert `past_due` on payment failure.                                                                                                                                                                                                                                                                                                                            |

**PR → main:** "Phase F2: Stripe Billing subscriptions + Customer Portal"
**Tag:** `v0.6.0` — revenue path live.

## Phase G — Stripe Issuing Compliance (Weeks 11–12)

**Goal:** Make the card product legally and operationally safe to run. Stripe Issuing requires KYC-verified cardholders, a cardholder agreement, and invite-only access early. Without this phase real card issuance is not permitted.

### Phase G1: Card access gates + KYC flow

**Branch:** `feat/phaseG/card-compliance`

| Commit                                          | What                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migration: add card compliance fields to orgs` | Add `card_access_granted_at TIMESTAMPTZ` (null = invite not yet granted), `card_tos_accepted_at TIMESTAMPTZ` (null = cardholder ToS not yet accepted), `kyc_status TEXT NOT NULL DEFAULT 'unverified'` (`unverified \| pending \| verified \| failed`), `kyc_session_id TEXT` (Stripe Identity session ID).                                                                                                                        |
| `feat: card access gate in issue_card action`   | Before `ResourceManager.provision()` for card type, check: (1) `org.card_access_granted_at IS NOT NULL` — throw `PolicyError('CARD_ACCESS_NOT_GRANTED', { message: "Card access is invite-only. Contact support." })` if not; (2) `org.card_tos_accepted_at IS NOT NULL` — throw `PolicyError('CARD_TOS_REQUIRED')` if not; (3) `org.kyc_status === 'verified'` — throw `PolicyError('KYC_REQUIRED')` if not. All three must pass. |
| `feat: POST /orgs/:id/admin/grant-card-access`  | Root-key-only admin endpoint (requires root key with no org scoping — system admin). Sets `card_access_granted_at = NOW()`. This is the manual invite gate. Intended for internal use until volume justifies automation.                                                                                                                                                                                                           |
| `feat: POST /orgs/me/card-tos-accept`           | Authenticated org root key accepts cardholder ToS. Sets `card_tos_accepted_at = NOW()`. Body must include `{ agreed: true }` to make acceptance explicit. Returns updated org state.                                                                                                                                                                                                                                               |
| `feat: POST /billing/kyc/start`                 | Creates a Stripe Identity verification session for the org. Stores `kyc_session_id` on org, sets `kyc_status = 'pending'`. Returns `{ url }` for the hosted verification flow.                                                                                                                                                                                                                                                     |
| `feat: POST /webhooks/stripe-billing` (extend)  | Handle `identity.verification_session.verified` → set `kyc_status = 'verified'`; `identity.verification_session.requires_input` → set `kyc_status = 'failed'`. Match session by `kyc_session_id` on org.                                                                                                                                                                                                                           |
| `test: card access gate`                        | Assert `issue_card` returns 422/PolicyError when any of the three gates are not set. Assert each gate independently. Assert full success when all three are set. Assert admin grant endpoint requires root key.                                                                                                                                                                                                                    |

**PR → main:** "Phase G1: card compliance gates + KYC flow"

### Phase G2: Real-time Stripe authorization handler

**Branch:** `feat/phaseG/realtime-authz`

> Stripe fires `issuing_authorization.request` synchronously and waits up to 2 seconds for a response. If no response, Stripe declines. This is separate from `issuing_authorization.created` (which is an after-the-fact notification). Enable real-time authorization in the Stripe Issuing dashboard before this goes live.

| Commit                                           | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat: issuing_authorization.request handler`    | In `/webhooks/stripe`, add case for `issuing_authorization.request`. Extract `authorization.card.id` (the `ic_...` ref), look up the resource by `provider_ref`. Checks in order: (1) resource exists and `state === 'active'` — decline if not; (2) agent exists and `is_archived = false` — decline if not; (3) org `subscription_status` is not `'canceled'` or `'past_due'` — decline if suspended. If all pass, call `stripe.issuing.authorizations.approve(authId)`. If any fail, call `stripe.issuing.authorizations.decline(authId)` with a reason code. |
| `feat: 1.5-second timeout guard`                 | Wrap the lookup + decision logic in a `Promise.race` against a 1.5-second timeout. On timeout, **decline** the authorization and log a warning. Fail-closed is the correct default for payments — a slow DB means we can't verify policy, so we must not approve. The agent can retry the purchase. Stripe auto-declines after 2s anyway, so declining at 1.5s gives us a clean audit event instead of an ambiguous Stripe-side decline. |
| `feat: emit authorization events after decision` | After `approve/decline` call completes, emit `payment.card.authorized` or `payment.card.declined` event via `EventWriter` asynchronously (do not block the response path).                                                                                                                                                                                                                                                                                                                                                                                       |
| `test: real-time authorization e2e`              | Mock `stripe.issuing.authorizations.approve` and `stripe.issuing.authorizations.decline`. Assert: active resource + active agent → approve called. Suspended resource → decline called. Archived agent → decline called. Canceled subscription → decline called. Timeout scenario → approve called with warning log.                                                                                                                                                                                                                                             |

**PR → main:** "Phase G2: real-time Stripe authorization handler"
**Tag:** `v0.7.0` — card product legally and operationally safe for real users.

## Cross-cutting Concerns (Build them in from Day 1)

These are non-negotiable for maintainability and ops sanity, but keep them lean.

### Logging + tracing

- JSON logs with: `request_id`, `org_id`, `agent_id`, `resource_id`, `event_id`
- A log redaction utility used by card issuance + webhook ingestion
- (Later) OpenTelemetry spans (nice-to-have once you have multiple services)

### Error handling (one pattern)

- `AppError` with code, httpStatus, details
- Canonical error codes: `UNAUTHENTICATED`, `FORBIDDEN`, `POLICY_DENIED`, `ADAPTER_TIMEOUT`, `WEBHOOK_INVALID_SIGNATURE`, `PROVIDER_RATE_LIMITED`

### Provider ops hardening (MVP-level)

- **Provider client wrapper with:** timeouts, bounded retries with jitter, standardized error mapping
- **Webhook processor:** dead-letter queue table (or job failure table) with reprocess tooling, replay endpoint (admin-only) for a stored webhook payload id

### Secrets management

- No provider keys in env vars in prod (use managed secret store)
- Store per-provider webhook secrets in DB (encrypted) if multi-tenant provider config becomes necessary later

## “When do we split into more services?” (Explicit triggers)

Keep MVP as one codebase / one image / two process types. Split when measured needs appear:

- **Split webhooks** into separate service when provider webhook volume spikes cause API latency or you need independent autoscaling.
- **Split adapter executors** when provider outbound calls dominate CPU/time and you want isolation per provider.
- **Introduce projected timeline tables** when derived timeline queries exceed acceptable p95 (or you need complex grouping).
- **Add Redis** when rate limiting accuracy becomes important or job queue throughput outgrows Postgres-based workers.

## Phase H — Agent Auth Protocol (Post-Revenue)

**Goal:** Replace coarse org-level API keys with per-agent cryptographic identity. Each agent acts autonomously within its granted capabilities — no human approval gates, no permission prompts. Safety comes from constraints set at provisioning time, not runtime interruptions.

**Why now (after billing, not before):** Agent Auth is the right auth model, but shipping it before revenue is over-engineering. The current API key model works fine for the personal wedge. Agent Auth becomes critical when teams have multiple agents with different permission needs.

**Relationship to Phase E3 auth hardening:** E3 adds `expires_at`, `max_spend_cents`, `allowed_actions` to the existing API key model. Those fields remain useful for org-level keys even after Agent Auth ships. Think of E3 as "hardened API keys for production" and Phase H as "per-agent identity for multi-agent teams." Both coexist — Agent Auth doesn't replace API keys, it adds a layer below them.

**What Agent Auth gives us:**
- Each agent gets its own Ed25519 keypair + scoped capability grants
- Constraints on grants: `"payment:send" — max: $500/day, mcc_categories: ["software"]`
- Independent agent lifecycle: `pending → active → expired → revoked`
- Three independent clocks: session TTL, max lifetime, absolute lifetime
- Host → agent hierarchy: revoking a host cascades to all child agents
- Discovery via `/.well-known/agent-configuration`
- Complements MCP (Agent Auth = identity/auth, MCP = tool transport)

**Autonomous by design:** The agent operates freely within its capability grants. If an agent has `payment:send` with `max: $500`, it spends up to $500 without asking anyone. If it has `email:send` with `domains: ["@company.com"]`, it sends to those domains instantly. The constraints ARE the safety — not human checkpoints. This is how humans work: your credit card has a limit, your email has a domain, and you don't ask permission for every transaction.

### Planned commits (scope TBD based on traction)

| Commit | What |
| --- | --- |
| `feat: /.well-known/agent-configuration` | Discovery endpoint exposing capabilities, supported auth |
| `feat: agent registration + JWT verification` | `POST /agent/register`, Ed25519 JWT verification alongside existing Bearer tokens |
| `feat: capability grants with constraints` | Map existing scopes to Agent Auth capabilities, add constraint operators (`max`, `min`, `in`, `not_in`) |
| `feat: autonomous constraint enforcement` | Policy engine checks constraints at action time — reject if exceeded, execute if within bounds, no approval flow |
| `test: agent auth e2e` | JWT auth, capability scoping, constraint enforcement, lifecycle states |

**PR → main:** "Phase H: Agent Auth Protocol"
**Tag:** `v0.8.0`

## Phase I — Payment Receiving + MPP (Post-PMF)

**Goal:** Close the payment loop. Agents already SEND payments via Stripe Issuing cards. Now let them RECEIVE payments (invoicing, payment links) and PAY for services on the open web via MPP. This is the feature no competitor has.

**Why this matters:** Humans both send and receive money. If agents can only spend but not earn, they're half-functional. Payment receiving + MPP makes AgentConnect the full-stack financial identity for agents.

**Payment receiving (Stripe Connect — separate from Stripe Billing in Phase F):**
- New resource type: `payment_account` (backed by Stripe Connect Express account per agent — requires migration to extend `resources.type` enum)
- Agent creates a Stripe Payment Link → shares via email → receives payment
- Agent creates + sends a Stripe Invoice → tracks payment status
- Webhook events: `payment.received`, `invoice.paid`, `invoice.overdue`
- Funds settle into the agent's connected account; org controls payout schedule

**MPP integration (machine-to-machine payments):**
- Agents with Stripe Issuing cards generate Shared Payment Tokens (SPTs)
- SPTs let agents pay for any MPP-enabled service (Cloudflare Workers, Browserbase, etc.) automatically via HTTP 402 flow
- AgentConnect can also ACCEPT MPP payments (charge agents per-request for API usage)
- Protocol: challenge-credential-receipt over `WWW-Authenticate: Payment` / `Authorization: Payment` headers
- SDK: `mppx` (TypeScript), production-ready, middleware for Express/Hono

### Planned commits (scope TBD based on ecosystem maturity)

| Commit | What |
| --- | --- |
| `feat: payment link creation + sharing` | Agent creates Stripe Payment Link, shares via email resource |
| `feat: invoice creation + send` | Agent creates Stripe Invoice, sends via email |
| `feat: payment.received webhook + events` | Ingest Stripe payment webhooks, emit `payment.received` events |
| `feat: MPP SPT generation for Issuing cards` | Enable agents to generate SPTs from their provisioned Stripe Issuing cards |
| `feat: MPP payee middleware` | Accept MPP payments on AgentConnect API (optional per-request billing) |
| `test: payment receiving + MPP e2e` | Payment link flow, invoice flow, SPT generation, MPP challenge-credential-receipt |

**PR → main:** "Phase I: payment receiving + MPP"
**Tag:** `v0.9.0`

## Deferred Roadmap (vNext, not MVP)

These remain out of the critical path. Adopt only when real demand appears:

- Generic policies table + full inheritance PolicyEngine
- SMS adapter (Twilio) — send + receive text messages
- Voice adapter (Twilio/LiveKit) — make + receive calls, real-time call control
- Full dashboard (start with OpenAPI + minimal admin page instead)
- Agent-to-agent delegation chains (Agent Auth Protocol extension)
- Cross-org agent identity federation

## Release Milestones (Lean)

| Tag      | What's shippable                                                                          |
| -------- | ----------------------------------------------------------------------------------------- |
| `v0.1.0` | Single deployable, orgs + API keys, agents                                                |
| `v0.2.0` | Canonical event log + `GET /agents/:id/events`                                            |
| `v0.3.0` | Email end-to-end (provision, send, ingest → events)                                       |
| `v0.4.0` | Card issuance + card webhooks + derived unified timeline                                  |
| `v0.5.0` | Validated Hermes MCP surface + OpenClaw hook delivery on the lean API/Worker architecture |
| `v0.5.1` | Auth hardening (key expiry, bounded auth, rate limiting, HMAC signing) + A2A Agent Card   |
| `v0.6.0` | Plan tiers + quota enforcement + Stripe Billing subscriptions — revenue path live         |
| `v0.7.0` | Stripe Issuing compliance: invite-only gate + KYC + real-time authorization               |
| `v0.8.0` | Agent Auth Protocol — per-agent cryptographic identity + autonomous constraint enforcement |
| `v0.9.0` | Payment receiving (links + invoicing) + MPP (agent-to-service payments)                   |

## Git Hygiene Reminders

- Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`)
- One logical change per commit (migrations separate)
- Never edit migrations after merge; add new ones
- Feature flags for unfinished providers/capabilities
- Tests in every PR (especially adapter/webhook paths)
- Rebase onto main before merging
