# System Architecture (MVP that scales)

## Full Project

**What we’re building:** A unified control plane + event log that maps real-world capabilities (email, SMS, voice calls, card payments, later wallets/x402) onto canonical `agent_id`s, with safe tool/MCP access and a per-agent timeline.

**Who it’s for:** Early wedge = teams already building LLM agents that need production comms + payments quickly:

- (a) agent platforms / orchestration frameworks
- (b) AI-native SaaS products giving each user/agent its own inbox/phone/card
- (c) infra teams at larger companies piloting agentic workflows.

**Why now / why we win:** Email-for-agents (AgentMail), card-for-agents (AgentCard), and protocols like MCP and x402 are maturing, but they’re all separate silos; identity, policy, and unified observability across rails are missing. We win by being the neutral, multi-rail “agent infra” layer that sits above providers and below orchestration frameworks.

## MVP

Single codebase, 2 process types (low cost, easy scaling). Ship one Node/TS repo + one container image, but run it as:

- **API process:** REST + inbound webhooks (+ later MCP)
- **Worker process:** async jobs (webhook processing, outbound delivery retries, backfills)

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

- **Trunk:** `main` — always deployable, protected, requires PR + 1 review.
- **Branch naming:**
  - `feat/<phase>/<description>` — new functionality
  - `fix/<description>` — bug fixes
  - `chore/<description>` — tooling, CI, docs
  - `refactor/<description>` — structural changes with no behavior change
- **PR rules:** squash-merge into main. Each PR maps to one logical unit below. Tag milestones with `v0.1.0`, `v0.2.0`, etc.

## Core Design Decisions (lock these before coding)

### Canonical entities

- `orgs` → owns everything
- `api_keys` → root + service (MVP)
- `agents` → canonical `agent_id`
- `resources` → “capabilities” attached to an agent (inbox, card)
- `events` → immutable canonical log (the product)

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

| Commit                                                     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat: AgentMailAdapter provision + deprovision`           | Call `client.inboxes.create()`. The response `inbox_id` **is** the full email address (e.g., `agent123@agentmail.to`). Store it as `provider_ref` on the resource row. Deprovision calls `client.inboxes.delete(inboxId)`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `feat: POST /agents/:id/actions/send_email`                | Lookup email resource → `enforceEmailPolicy` → call `client.inboxes.messages.send(resource.provider_ref, { to, subject, text, html?, cc?, bcc?, reply_to? })` (TS SDK: `inbox_id` is positional first arg, remaining fields are the second object arg). Emit `email.sent` event with idempotency via action `idempotency_key`.                                                                                                                                                                                                                                                                                                                  |
| `feat: inbound webhook endpoint`                           | `POST /webhooks/agentmail` — **Expose raw body buffer** (do not parse JSON before verification). Verify using the Svix library: `new Webhook(secret).verify(rawBody, headers)` where headers must include `svix-id`, `svix-timestamp`, and `svix-signature`. On success, enqueue raw payload + headers for async processing and return `200` immediately.                                                                                                                                                                                                                                                                                       |
| `feat: webhook job processor (email)`                      | AgentMail payload shape: `{ event_type, event_id, organization_id, inbox_id, message: { message_id, thread_id, from, to, subject, text, html, preview, timestamp, ... } }`. Map `event_id` → `provider_event_id` for deduplication. Canonical mappings: `message.received` → `email.received`, `message.sent` → `email.sent`, `message.delivered` → `email.delivered`, `message.bounced` → `email.bounced`, `message.complained` → `email.complained`, `message.rejected` → `email.rejected`. Extract `thread_id` and `message_id` from nested `message` object; note the JSON key is `"from"` (not `from_` — that is a Python SDK alias only). |
| `feat: provider client wrapper`                            | Timeouts, retries with jitter for outbound API calls; circuit-breaker hooks (lightweight).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test: email send + webhook ingestion e2e (mock provider)` | Mock AgentMail API + generate Svix-signed webhook payloads (use test secret + Svix test helper). Assert canonical events written to DB with correct `provider_event_id`, `thread_id`, and `from` field.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs: provider integration contract`                      | Document AgentMail webhook payload fields depended on: `event_id` (dedup key), `event_type`, `message.thread_id`, `message.message_id`, `message.from`, `message.timestamp`. Note all 6 canonical email event types supported.                                                                                                                                                                                                                                                                                                                                                                                                                  |

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

**Goal:** Orchestrators can discover/call tools via MCP, and customers can subscribe to events from your control plane.

### Branch: `feat/phaseE/mcp-gateway`

| Commit                                    | What                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `feat: MCP server module (minimal tools)` | Tools: `agentinfra.email.send`, `agentinfra.payments.issue_card`, `agentinfra.events.list`, `agentinfra.timeline.list`. |
| `feat: MCP auth via API key`              | `AGENTINFRA_API_KEY` resolves org + scopes; tool list reflects scopes.                                                  |
| `feat: call_tool dispatch`                | Map tools → internal REST handlers/services (avoid duplicating logic).                                                  |
| `docs: MCP integration guide`             | Claude Desktop/Cursor config examples; recommended scopes.                                                              |
| `test: MCP list_tools + call_tool e2e`    | Ensure tool schemas stable + errors typed.                                                                              |

**PR → main:** “Phase E1: MCP gateway (thin)”
**Tag:** `v0.5.0`

### Branch: `feat/phaseE/outbound-webhooks`

| Commit                                                 | What                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migration: create webhook_subscriptions + deliveries` | `webhook_subscriptions(id, org_id, url, event_types[], signing_secret, status, created_at)` and `webhook_deliveries(id, subscription_id, event_id, attempt_count, last_status, next_attempt_at, created_at, updated_at)`. |
| `feat: POST /webhook-subscriptions`                    | Create subscription + generate secret; validate URL allowlist (basic SSRF guard).                                                                                                                                         |
| `feat: delivery worker (retries)`                      | Worker picks new events → fanout to subs → HMAC signature → 3 retries exponential backoff.                                                                                                                                |
| `feat: GET /webhook-subscriptions/:id/deliveries`      | Debug recent failures/success.                                                                                                                                                                                            |
| `test: outbound delivery + retry`                      | Fake endpoint, assert retries and final status.                                                                                                                                                                           |

**PR → main:** “Phase E2: outbound webhooks (thin, reliable enough)”

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

## Deferred Roadmap (vNext, not MVP)

These remain in your original plan, but moved out of the critical path:

- Generic policies table + full inheritance PolicyEngine
- Delegated keys + richer key hierarchy
- Approvals flow + verification URL
- SMS (then voice)
- Wallet/x402 adapter
- Full dashboard (start with OpenAPI + minimal admin page instead)

## Release Milestones (Lean)

| Tag      | What's shippable                                                        |
| -------- | ----------------------------------------------------------------------- |
| `v0.1.0` | Single deployable, orgs + API keys, agents                              |
| `v0.2.0` | Canonical event log + `GET /agents/:id/events`                          |
| `v0.3.0` | Email end-to-end (provision, send, ingest → events)                     |
| `v0.4.0` | Card issuance + card webhooks + derived unified timeline                |
| `v0.5.0` | MCP tools for email/card/events/timeline (+ optional outbound webhooks) |

## Git Hygiene Reminders

- Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`)
- One logical change per commit (migrations separate)
- Never edit migrations after merge; add new ones
- Feature flags for unfinished providers/capabilities
- Tests in every PR (especially adapter/webhook paths)
- Rebase onto main before merging
