# System Architecture (MVP that scales)

## Full Project

**What we’re building:** A unified control plane + event log that lets AI agents send and receive emails and make payments — with safe tool/MCP access and a per-agent timeline.

**Who it’s for:** First wedge = personal AI users and prosumers who want managed, fast, safe access to real-world capabilities for their agent. Expansion = power users, small teams, startups (see `business-plan.md` for full go-to-market).

**Why now / why we win:** Email-for-agents (AgentMail), card-for-agents (AgentCard, Slash), and protocols like MCP are maturing, but they’re all separate silos. Nobody unifies email + payments under one agent identity with policy, observability, and audit across all rails. We win by being the only product where one `agent_id` can send an email, buy something with a virtual card, and have the full activity timeline in one place.

**Current status (March 2026):** MVP beta ready. Phases A–E2 built (intern), Sprints 0–4 complete (billing, ops, onboarding). 197 tests passing. Ready to deploy to Railway and onboard first paying users.

**Protocol strategy:** Three layers, adopted incrementally:
- **MCP** — tool/capability transport (shipped, Phase E)
- **Agent Auth Protocol** (agent-auth-protocol.com) — per-agent cryptographic identity, scoped capability grants. Deferred until multi-agent teams need it.
- **MPP** (mpp.dev, Stripe + Tempo) — HTTP 402-based machine-to-machine payments. Deferred until ecosystem matures.

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

### Phase E3: Auth Hardening — CUT FOR MVP

> **Status:** Cut. Key expiry, HMAC signing, rate limiting, and A2A Agent Card are not needed for the first 50 beta users. Manual key revocation is sufficient. Revisit after first paying customers.

## Phase F — MVP Beta: Billing + Ops + Onboarding (COMPLETED)

**Goal:** Get from "working code" to "deployable product with revenue path." Replaces the original Phase F (usage_counters table + 6-tier billing) and Phase G (KYC + real-time authz) with a leaner approach.

**What was actually built (Sprints 0–4):**

### Sprint 0: Security fixes
- `transitionState` current-state guard in `OutboundActionDal` (`src/db/dal.ts`)
- Ephemeral key filtered from MCP text content (`src/mcp/tools/payments.ts`)
- DNS rebinding check at webhook delivery time (`src/domain/outbound-webhooks.ts`)
- `findByIdempotencyKey` scoped by action type (`src/db/dal.ts`)
- `withTimeout` signal documented as accepted behavior (`src/api/routes/outbound-email-actions.ts`)

### Sprint 1: Billing + signup gate + plan quotas
- **Signup gate:** `SIGNUP_SECRET` env var, required as `x-signup-secret` header on `POST /orgs` when configured (`src/api/routes/orgs.ts`)
- **Schema:** Added billing fields to `orgs` table — `plan_tier` (enum: starter/personal/power), `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `current_period_end` (`src/db/schema.ts`, migration `0005`)
- **Billing service:** `src/domain/billing.ts` — `createCheckoutSession()`, `createPortalSession()`, `syncSubscription()`. Handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- **Billing routes:** `POST /billing/checkout` → returns `{ url }`, `POST /billing/portal` → returns `{ url }` (`src/api/routes/billing.ts`)
- **Billing webhook:** `POST /webhooks/stripe-billing` — separate from issuing webhook (`src/api/routes/webhooks.ts`)
- **Subscription enforcement:** `onRequest` hook in `server.ts`, only active when `SIGNUP_SECRET` is configured. Returns 402 for inactive subscriptions. Exempts `/health`, `/webhooks/`, `/orgs`, `/billing/`, `/mcp`
- **Plan quotas:** `src/domain/billing-limits.ts` — enforced via `COUNT(*)` queries on existing tables (no separate `usage_counters` table). Limits:

| | Starter ($19) | Personal ($29) | Power ($49) |
|---|---|---|---|
| Agents | 1 | 1 | 3 |
| Inboxes | 1 | 1 | 3 |
| Emails/mo | 1,000 | 2,000 | 5,000 |
| Cards/mo | 5 | 15 | 50 |

- **Cards included at every tier** — not gated behind a separate plan. Safe defaults applied via Stripe's native `spending_controls`: $500/day limit, blocked cash advances + gambling (`src/adapters/stripe-adapter.ts`)
- **Tests:** 8 new billing tests (`tests/billing.test.ts`)

### Sprint 2: Landing page + onboarding
- Updated landing page at `lab-landing/agentconnect.html` — positioned around unification ("One identity for your autonomous AI agent. Email. Payments. Full audit trail.")
- Added pricing section (3 tiers, cards at every tier)
- Added MCP / Claude Desktop section with `claude_desktop_config.json` example
- Updated code examples to match actual API
- Removed phone/telephony references (not implemented)

### Sprint 3: Operational readiness
- **Health probe:** `SELECT 1` DB check, returns 503 on failure (`src/api/routes/health.ts`)
- **Structured log context:** `orgId` + `keyId` added to request logs after auth resolution (`src/plugins/auth.ts`)
- **Graceful shutdown:** SIGTERM/SIGINT handlers for API (`server.close()`) and Worker (`shuttingDown` flag finishes current drain cycle) (`src/api/server.ts`, `src/worker/outbound-webhooks.ts`)

### Sprint 4: Differentiation
- **MCP tool description polish:** All tool descriptions updated to emphasize unified cross-capability experience (`src/mcp/tools/*.ts`)
- **Safe card defaults:** Conservative `spending_controls` applied when user doesn't specify any (`src/adapters/stripe-adapter.ts`)

**197 tests passing** (163 unit + 34 integration). `pnpm run verify` passes.

**Tag:** `v0.5.0` — MVP beta ready for first paying users.

---

## Original Phase G — Stripe Issuing Compliance — DEFERRED

> **Status:** Deferred. Stripe's built-in `spending_controls` + safe defaults at card creation + manual invite via `SIGNUP_SECRET` is sufficient for beta. KYC, cardholder ToS gates, and real-time `issuing_authorization.request` handling are not needed until volume justifies it.

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

## Phase G — Agent Auth Protocol (Post-Revenue, DEFERRED)

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

**PR → main:** "Phase G: Agent Auth Protocol"
**Tag:** `v0.6.0`

## Phase H — Payment Receiving + MPP (Post-PMF, DEFERRED)

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

**PR → main:** "Phase H: payment receiving + MPP"
**Tag:** `v0.7.0`

## Deferred Roadmap (vNext, not MVP)

These remain out of the critical path. Adopt only when real demand appears:

- Generic policies table + full inheritance PolicyEngine
- SMS adapter (Twilio) — send + receive text messages
- Voice adapter (Twilio/LiveKit) — make + receive calls, real-time call control
- Full dashboard (start with OpenAPI + minimal admin page instead)
- Agent-to-agent delegation chains (Agent Auth Protocol extension)
- Cross-org agent identity federation

## Release Milestones (Lean)

| Tag      | What's shippable                                                                          | Status |
| -------- | ----------------------------------------------------------------------------------------- | ------ |
| `v0.1.0` | Single deployable, orgs + API keys, agents                                                | Done |
| `v0.2.0` | Canonical event log + `GET /agents/:id/events`                                            | Done |
| `v0.3.0` | Email end-to-end (provision, send, ingest → events)                                       | Done |
| `v0.4.0` | Card issuance + card webhooks + derived unified timeline                                  | Done |
| `v0.5.0` | MCP gateway + outbound webhooks + billing + quotas + ops readiness + landing page          | Done |
| `v0.6.0` | Agent Auth Protocol — per-agent cryptographic identity + autonomous constraint enforcement | Deferred |
| `v0.7.0` | Payment receiving (links + invoicing) + MPP (agent-to-service payments)                   | Deferred |

## Git Hygiene Reminders

- Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`)
- One logical change per commit (migrations separate)
- Never edit migrations after merge; add new ones
- Feature flags for unfinished providers/capabilities
- Tests in every PR (especially adapter/webhook paths)
- Rebase onto main before merging
