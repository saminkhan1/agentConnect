# AgentConnect

A unified control plane and event log that maps real-world capabilities (email, card payments, and later SMS/voice/wallets/x402) onto canonical `agent_id`s, providing safe tool/MCP access and a per-agent timeline.

## 🌟 Why AgentConnect?

Email-for-agents (AgentMail), card-for-agents (AgentCard), and protocols like MCP and x402 are maturing, but they often exist as separate silos. Identity, policy, and unified observability across these rails are missing.

AgentConnect aims to be the neutral, multi-rail **"agent infrastructure"** layer that sits above providers and below AI orchestration frameworks. It gives each of your agents its own inbox and card, all tied together in a single, safe, and observable control plane.

### Target Audience

- **Agent Platforms & Orchestration Frameworks:** Looking to provide built-in capabilities to their agents.
- **AI-Native SaaS:** Giving each automated user/agent its own inbox, phone number, and card.
- **Infrastructure Teams:** Assisting companies piloting agentic workflows at scale.

---

## 🚀 Features

- **Unified Agent Identity:** Map all current capabilities (cards, emails) and future ones (numbers, wallets) to canonical `agent_id`s.
- **Root and Service API Keys:** Bootstrap an org with a root key, mint service keys for day-to-day automation, and rotate or revoke root keys without downtime.
- **Real-time Event Log and Timeline:** A canonical, paginated timeline of agent activity plus derived email and card groupings.
- **Email Integration:** Provision inboxes, send and reply through AgentMail, and require explicit `idempotency_key` values for safe retries.
- **Virtual Cards and Billing:** Issue agent-scoped virtual cards with Stripe Issuing and manage subscription checkout and billing portal flows.
- **Outbound Webhook Delivery:** Fan out canonical events or bounded OpenClaw hook payloads with retry policy, delivery logs, and signed metadata headers.
- **MCP Integration:** Expose capabilities over stdio and optional HTTP/SSE so agents can discover and call tools securely. Payment tools are advertised only when Stripe is configured.
- **Multi-tenant:** Built from the ground up to support multiple organizations with strict data isolation.

---

## 🛠️ Tech Stack

- **Runtime:** [Node.js](https://nodejs.org/) & [TypeScript](https://www.typescriptlang.org/)
- **Framework:** [Fastify](https://fastify.dev/) for high-performance API routing
- **Database:** [PostgreSQL](https://www.postgresql.org/) (Source of truth & event log)
- **ORM:** [Drizzle ORM](https://orm.drizzle.team/)
- **Validation:** [Zod](https://zod.dev/)

---

## 💻 Local Development Setup

### Prerequisites

- Node.js (v20+ recommended)
- Docker & Docker Compose (for the local Postgres database)
- pnpm

### Running the Project

1. **Clone the repository:**

   ```bash
   git clone https://github.com/your-username/agentconnect.git
   cd agentconnect
   ```

2. **Install dependencies:**

   ```bash
   pnpm install
   ```

3. **Start local infrastructure (Postgres):**

   ```bash
   docker-compose up -d     # Start Postgres 16 on localhost:5432
   ```

4. **Create `.env`:**
   This repo does not ship a checked-in `.env.example`, so create `.env` yourself and set the variables you need.

   Required for common flows:

   - `DATABASE_URL` (optional locally; defaults to `postgresql://postgres:password@localhost:5432/agentconnect_dev`)
   - `AGENTMAIL_API_KEY`
   - `AGENTMAIL_WEBHOOK_SECRET`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`

   Optional but commonly used:

   - `MCP_HTTP_ENABLED=true` to expose `/mcp`
   - `MCP_ALLOWED_ORIGINS=https://app.example.com` for MCP browser CORS
   - `SIGNUP_SECRET` to enable subscription enforcement
   - `STRIPE_BILLING_WEBHOOK_SECRET` plus `STRIPE_PRICE_ID_*` values for billing flows

5. **Run database migrations:**

   ```bash
   pnpm run db:push          # Force-push schema to DB (dev/test only — no migration files)
   pnpm run db:migrate       # Apply migration files (programmatic, for prod/CI)
   ```

6. **Start the development server:**

   ```bash
   source .env && pnpm run dev   # Start server — MUST source .env first; missing vars silently disable AgentMail adapter
   ```

   The API will be available at `http://localhost:3000`.

7. **Run optional local sidecars:**

   ```bash
   pnpm run worker:webhooks  # Deliver outbound webhook retries
   pnpm run mcp:stdio        # Start the MCP server over stdio
   ```

8. **Expose local webhook routes over Cloudflare Tunnel (optional):**
   ```bash
   pnpm run dev:webhooks
   ```
   This runs the free TryCloudflare flow for your current local `PORT` and prints a random public `trycloudflare.com` URL. See `docs/cloudflare-tunnel.md` for the full dev workflow.

### Integration Guides

- AgentMail email provider integration: `docs/agentmail-integration.md`
- Local webhook tunneling: `docs/cloudflare-tunnel.md`
- OpenClaw + Hermes production integration: `docs/openclaw-hermes-integration.md`

### API Workflow Notes

- `POST /orgs` returns a root key once. Use that root key to create service keys, rotate root keys, and revoke retired keys.
- `POST /orgs/:id/api-keys/rotate-root` issues a new root key while the current root key stays active until you revoke it with `POST /orgs/:id/api-keys/:keyId/revoke`.
- `POST /billing/checkout` and `POST /billing/portal` accept root keys only.
- `POST /agents/:id/actions/send_email` and `POST /agents/:id/actions/reply_email` require a non-empty `idempotency_key`.
- `GET /health` reports `webhookDeliveryBacklog` so operators can spot stuck outbound deliveries.
- Payment MCP tools are omitted when Stripe is not configured; the rest of the MCP surface still works.

### Testing & Linting

- **Run all verification checks (Lint + Format + Types + Test):**
  ```bash
  pnpm run verify
  ```
- **Run typecheck only:**
  ```bash
  pnpm run typecheck
  ```
- **Run Unit Tests:**
  ```bash
  pnpm test                 # Unit tests (tests/*.test.ts)
  ```
- **Run Integration Tests:**
  ```bash
  pnpm run test:integration # Runs drizzle-kit migrate, then tests/*.integration.ts
  ```
- **Run the live Stripe smoke test (real keys required):**
  ```bash
  pnpm run test:stripe-live
  ```
- **Auto-fix formatting & linting issues:**
  ```bash
  pnpm run fix              # Powered by Biome
  ```

---

## 🤝 Contributing

We welcome community contributions! This project is maintained as an open-source tool, and we'd love your help to add more capabilities (SMS, voice, new MCP tools).

### Getting Started with Contributing

1. **Fork the repository** and create your branch from `main`.
2. **Branch naming convention:**
   - `feat/<phase>/<description>` — new functionality
   - `fix/<description>` — bug fixes
   - `chore/<description>` — tooling, CI, docs
   - `refactor/<description>` — structural changes with no behavior change
3. **Commit Messages:** We follow Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`). One logical change per commit.
4. **Testing:** Ensure all new features are covered by tests (`pnpm test`). Do not break existing tests.
5. **Database Migrations:** Migrations are always a separate commit. **Never edit migrations after they are merged.**
6. **Open a Pull Request:** Describe your changes in detail, and tag any related issues. Ensure `pnpm run verify` passes.

### Core Architecture & Principles

- **Keep it lean:** We favor a single Node/TypeScript codebase designed to run as an API process and a Worker process using a simple PostgreSQL-first architecture.
- **Security & Isolation:** Multitentant isolation is strictly enforced via a DAL pattern (`DalFactory(orgId)`).
- **Sensitive Data:** Never persist sensitive API keys or PAN/CVV data. Keys are hashed with scrypt.
- **Idempotency & Events:** All state changes emit canonical events to an immutable append-only log. The `EventWriter` handles concurrent deduplication via advisory locks.

## 📝 License

[MIT License](LICENSE) (or add your preferred Open Source License here).
