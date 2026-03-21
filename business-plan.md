# Personal-Agent-First Business Plan

## Goal

AgentConnect should become profitable quickly by being the easiest way to connect a personal AI agent to real-world providers. The first wedge is not "enterprise agent infrastructure." The first wedge is managed, fast, safe access for individuals and prosumers who want their AI agent to send email and make tightly bounded payments — both from day 1, under one identity.

The expansion path is:

- personal user
- power user / creator
- household or side-project team
- small startup team
- dedicated or BYO provider accounts only when scale actually requires it

## Core Thesis

People do not want to learn AgentMail, Stripe Issuing, webhooks, quotas, retries, and operational controls just to give an AI agent basic real-world ability.

They want:

- a real inbox for their agent
- simple connection to tools like OpenClaw
- clear logs and guardrails
- safe defaults
- setup in minutes

That is the product.

## Marketing Position

The positioning should be concrete and consumer-understandable. Lead with the unification — that's the moat.

- "One identity for your autonomous AI agent. Email. Payments. Full audit trail."
- "Your agent sent an email to a vendor, then bought supplies on Amazon — and you can see both in one timeline."
- "One MCP config gives your Claude agent email and payment capabilities."
- "Instead of managing AgentMail + AgentCard separately, one API key covers everything."

### Example stories

- My AI assistant wrote and sent an email to my landlord about a maintenance problem, then paid the plumber with a virtual card — and I can see both in one timeline.
- My Claude Desktop agent has one MCP config that lets it send emails, issue cards, and check its own activity history.

Those examples are stronger than generic "agent infrastructure" messaging because they show clear utility and emphasize the cross-capability value no competitor offers.

## Who We Serve First

### Primary wedge

- individual OpenClaw users
- personal AI power users
- indie hackers
- creators experimenting with personal agents
- people who want managed setup, not provider plumbing

### Expansion market

- two-person or three-person product teams
- small startups using agents internally
- AI-native SaaS teams that start with one founder’s personal workflow and then want team usage

### Customers to avoid at launch

- bargain hunters who only want the cheapest possible inbox
- mass outbound or spammy email users
- users expecting unlimited support at very low price points
- high-volume card users
- regulated fintech or large-company procurement-heavy customers before the product is mature

## What We Sell

- managed email provisioning for AI agents (send + receive)
- managed virtual cards for AI agents (spend + controls) — included at every tier
- MCP gateway for Claude Desktop and any MCP-compatible client (one config, all capabilities)
- OpenClaw-compatible outbound webhooks
- unified event log and timeline for all agent actions across email + payments
- safety controls and quotas (agents act autonomously within policy constraints — no human approval gates)
- one agent identity that works across email and payments
- later: payment receiving for agents (payment links, invoicing)

The product is not just access to a provider. The product is managed access, safety, visibility, and speed. The differentiator is unification — no competitor lets one agent send an email AND buy something with full audit trail under one identity.

## Product Ladder (Shipped)

All plans include email + virtual cards from day 1. The unification IS the product — cards are not gated behind a separate tier.

| Plan     | Price   | Includes                                                                                                  | Intended user                     |
| -------- | ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Starter  | $19/mo  | 1 agent, 1 inbox, 1,000 emails, 5 cards/mo, unified timeline, MCP gateway                                | curious personal users            |
| Personal | $29/mo  | 1 agent, 1 inbox, 2,000 emails, 15 cards/mo, unified timeline, outbound webhooks, MCP gateway             | active personal AI users          |
| Power    | $49/mo  | 3 agents, 3 inboxes, 5,000 emails, 50 cards/mo, unified timeline, outbound webhooks, MCP gateway          | power users and small teams       |

Team tiers ($249+) deferred until demand appears. The expansion path is personal → power → team, but team features won't be built until at least 3 Power users request them.

### Pricing rules

- no free managed tier
- no unlimited plans
- cards included at every tier with safe defaults (Stripe spending_controls: $500/day, blocked cash advances + gambling)
- beta access gated by SIGNUP_SECRET (manual invite), not card-specific invite
- support is productized and async on lower tiers, not white-glove concierge
- low personal-tier prices are for acquisition, not concierge-level support

## Cost Model and Break-even Math

These assumptions are designed for a lean bootstrapped operation as of March 13, 2026.

### Monthly cost assumptions

Deployment baseline:

- one small web service: `$7/month`
- one small worker: `$7/month`
- one managed Postgres instance: `$19/month`
- domain, DNS, email, and misc tooling assumption: `$5/month`

Email provider baseline:

- AgentMail Developer: `$20/month` for `10 inboxes` and `10,000 emails/month`
- AgentMail Startup: `$200/month` for `150 inboxes` and `150,000 emails/month`

Card provider baseline:

- Stripe fixed monthly fee assumed: `$0/month`
- virtual card issuance assumed around `$0.10/card`
- disputes and special fees are variable and must be passed through or tightly controlled

### Zero-customer monthly burn

| Item                | Monthly cost |
| ------------------- | ------------ |
| Web service         | $7           |
| Worker              | $7           |
| Postgres            | $19          |
| Domain, DNS, misc   | $5           |
| AgentMail Developer | $20          |
| Stripe fixed cost   | $0           |
| Total               | $58          |

`$58/month` is the cost to keep the application live with no paying users.

### Early shared-production monthly burn

This is the realistic cost once we have active managed users.

| Item              | Monthly cost |
| ----------------- | ------------ |
| Web service       | $7           |
| Worker            | $7           |
| Postgres          | $19          |
| Domain, DNS, misc | $5           |
| AgentMail Startup | $200         |
| Stripe fixed cost | $0           |
| Total             | $238         |

`$238/month` is the practical baseline once the product is actually in use.

### Capacity math for shared email

To avoid edge-of-capacity operations, only sell against 80% of AgentMail capacity.

#### Developer plan usable capacity

| Resource     | Raw capacity | Usable at 80% |
| ------------ | ------------ | ------------- |
| Inboxes      | 10           | 8             |
| Emails/month | 10,000       | 8,000         |

At `Starter` limits of `1 inbox` and `1,000 emails`:

- one Developer pool can support `8` Starter users before email volume is the bottleneck

#### Startup plan usable capacity

| Resource     | Raw capacity | Usable at 80% |
| ------------ | ------------ | ------------- |
| Inboxes      | 150          | 120           |
| Emails/month | 150,000      | 120,000       |

At current plan limits:

- Starter (`1 inbox`, `1,000 emails`) fits `120` users by email volume
- Personal (`1 inbox`, `2,000 emails`) fits `60` users by email volume
- Power (`3 inboxes`, `5,000 emails`) fits `24` users by email volume, `40` by inbox count

This means email volume, not inbox count, is the first constraint for the personal wedge.

### Customers needed to cover 100% of deployment and service cost

#### Zero-customer live baseline: $58/month

| Plan     | Revenue per customer | Customers needed to cover $58 |
| -------- | -------------------- | ----------------------------- |
| Starter  | $19                  | 4                             |
| Personal | $29                  | 2                             |
| Power    | $49                  | 2                             |

#### Shared-production baseline: $238/month

| Plan     | Revenue per customer | Customers needed to cover $238 |
| -------- | -------------------- | ------------------------------ |
| Starter  | $19                  | 13                             |
| Personal | $29                  | 9                              |
| Power    | $49                  | 5                              |

### Contribution margin by plan

To estimate gross margin, allocate only AgentMail Startup cost across the usable `120,000` monthly email pool, plus card issuance cost (~$0.10/card).

| Plan     | MRR  | Allocated provider cost                                         | Approx gross margin before support |
| -------- | ---- | --------------------------------------------------------------- | ---------------------------------- |
| Starter  | $19  | `(1,000 / 120,000) * $200 = $1.67` + `5 cards * $0.10 = $0.50` | about `$16.83`                     |
| Personal | $29  | `(2,000 / 120,000) * $200 = $3.33` + `15 * $0.10 = $1.50`      | about `$24.17`                     |
| Power    | $49  | `(5,000 / 120,000) * $200 = $8.33` + `50 * $0.10 = $5.00`      | about `$35.67`                     |

This is why the product can work financially. Provider cost is low. The real costs are support, trust, abuse handling, and engineering time.

### Customers needed to cover a lean founder burn

If the real goal is to cover founder survival plus operating costs:

- shared-production baseline: `$238/month`
- lean founder draw target: `$8,000/month`
- total required monthly coverage: `$8,238/month`

Ignoring payment processing and support overhead for a moment:

| Plan mix      | Customers needed to cover $8,238 |
| ------------- | -------------------------------- |
| Starter only  | `434`                            |
| Personal only | `285`                            |
| Power only    | `169`                            |

This is the most important math in the document:

- a pure low-ticket personal business needs a lot of users
- power users compress the path to profitability
- the best business is personal wedge plus power user expansion
- the low entry tier is a growth lever, not the whole business
- team tiers ($249+) will compress this further when demand appears

### Card economics

Cards are included at every tier but riskier than email. Safe defaults mitigate risk.

- estimated virtual card fee: about `$0.10` per card
- one `$15` dispute can wipe out the gross profit from roughly `7-8` cards
- safe defaults applied at card creation: $500/day spending limit, blocked cash advances + gambling

Conclusion:

- cards included from day 1 (the unification IS the product)
- overall beta access gated by SIGNUP_SECRET (manual invite)
- spending limits enforced by Stripe's native `spending_controls` at card creation
- merchant/category controls available and defaults are conservative
- pass-through fees must be explicit in terms
- monitor dispute patterns closely in early beta

## Business Model

### Phase 1 business (SHIPPED)

The first business is:

- managed email + virtual cards for AI agents under one identity
- self-serve onboarding via SIGNUP_SECRET invite + Stripe Checkout
- MCP gateway as the primary activation path (Claude Desktop, any MCP client)
- OpenClaw integration via outbound webhooks
- 3 plan tiers: Starter ($19), Personal ($29), Power ($49) — all include email + cards

### Phase 2 business (NEXT)

The second business is:

- power users with multiple agents (Power tier already supports 3)
- payment receiving beta (agent creates payment links, sends invoices)
- early teams who started from a personal use case

### Phase 3 business (FUTURE)

The third business is:

- small teams and startups (team tiers)
- per-agent identity via Agent Auth Protocol (each agent has its own scoped capabilities)
- MPP-enabled agents (agents can pay for services on the open web)
- higher limits
- quotas and billing controls
- dedicated or BYO provider migration only when volume actually justifies it

## Go-to-Market Plan

### Phase 0: prove the personal story (DONE)

- Landing page live, positioned around unification: "One identity. Email. Payments. Full audit trail."
- MCP / Claude Desktop integration angle prominent
- Pricing section with 3 tiers, cards at every tier
- "Request Beta" CTA with email form

### Phase 1: launch Starter, Personal, Power (READY TO DEPLOY)

All billing infrastructure is built. Next steps:

- deploy to Railway (API + Worker)
- verify healthcheck, webhook delivery, MCP HTTP in production
- smoke test with real AgentMail inbox + Stripe test mode card
- manually invite first 10-20 beta users via SIGNUP_SECRET
- each user: POST /orgs → Stripe Checkout → create agent → provision inbox + issue card → connect MCP

Exit criteria:

- first paying personal users live
- at least 10 combined paying users across all tiers
- support load low enough that setup does not require manual founder intervention every time

### Phase 2: grow and retain (NEXT)

- monitor card usage patterns, disputes, and support tickets
- iterate on safe defaults based on real usage
- add payment receiving (agent creates payment links, sends invoices) if demand appears
- iterate on MCP tool descriptions based on user feedback

Exit criteria:

- at least 20 paying users
- no unacceptable fraud or dispute pattern
- card + email workflows creating real retention, not just demos

### Phase 3: convert users into teams (FUTURE)

- add shared workspace features
- add team tiers ($249+)
- add multiple agents per account (Power tier already supports 3)
- add quotas and usage reporting dashboard

Exit criteria:

- first 3 team customers
- at least one upgrade path from personal user to team account
- team revenue becomes a meaningful share of MRR

## Competitive Landscape (as of March 2026)

Nobody else unifies email + payments under one agent identity. That's the moat.

| Competitor | What they do | What they don't do |
| --- | --- | --- |
| **AgentMail** | Email inboxes for agents | No payments, no unified timeline |
| **CardForAgent** | Virtual cards via Stripe Issuing + MCP tools | No email, no payment receiving, no policy engine |
| **Slash for Agents** | Cards + payments + MCP + human approval gates | No email, no event log, enterprise pricing, requires human-in-the-loop |
| **Laso Finance** | Crypto-to-prepaid cards (no-KYC) | No agent identity, no controls, crypto-only |
| **Crossmint** | Wallets + cards for agents | Crypto-native, no email, complex setup |

### Emerging protocols we will adopt (lean, incremental)

- **Agent Auth Protocol** (agent-auth-protocol.com) — per-agent cryptographic identity with scoped capabilities. Adopt after billing ships. Gives us finer-grained auth than any competitor.
- **MPP** (mpp.dev, Stripe + Tempo) — HTTP 402 machine-to-machine payments. Launched March 2026. Lets our agents pay for any MPP-enabled service automatically. Adopt when ecosystem matures.
- **MCP** — already shipping (Phase E). Tool transport layer.

These protocols are additive. They don't change the product or pricing — they make our agent identity more capable than competitors' simple API keys.

## Product Priorities

### Shipped

- signup gate (SIGNUP_SECRET)
- Stripe Billing (Checkout + Portal + webhook sync)
- subscription enforcement (402 for inactive)
- plan-based quotas (agents, inboxes, emails/mo, cards/mo)
- email send/receive with domain policy enforcement
- virtual card issuance with safe spending_controls defaults
- event log and unified timeline
- MCP gateway (stdio + HTTP/SSE) with polished tool descriptions
- outbound webhooks (OpenClaw + Hermes compatible)
- health probe with DB check
- graceful shutdown
- structured log context (orgId, keyId)
- landing page with pricing and MCP integration angle
- security fixes (state guard, ephemeral key, DNS rebinding, idempotency key scoping)

### Build after traction

- payment receiving (Stripe Payment Links + Invoicing for agents)
- richer workspace/team controls + team tiers
- Agent Auth Protocol (per-agent identity + scoped capabilities)
- Sentry error reporting
- polished admin panel
- dedicated or BYO provider support for larger customers

### Defer

- MPP integration (wait for ecosystem adoption)
- voice
- SMS
- physical cards
- KYC / real-time Stripe authorization (Stripe spending_controls sufficient for beta)
- auth hardening (key expiry, HMAC signing, rate limiting)
- agent-to-agent delegation chains
- generic workflow builder
- enterprise-only compliance work before demand exists

## Support Strategy

Easy access does not mean unlimited human labor.

- lower tiers must rely on productized onboarding, docs, and async support
- invite-only card access keeps the risky support burden small
- power users and teams can justify more direct support
- if an individual customer consumes excessive support time, upgrade them, restrict them, or churn them

## Weekly Metrics

- new signups
- activated users
- paying personal users
- paying power users
- team upgrades
- churn
- support tickets per active customer
- inbox provisioning success rate
- emails sent per active user
- shared email capacity used
- dispute count for card beta
- MRR

## Decision Rules

- if personal users activate but do not pay, the value proposition is interesting but not yet a business
- if support cost per personal user is too high, simplify the product before adding more users
- if the majority of revenue stays on Starter, the pricing ladder is too weak and upgrades are not working
- if cards create excitement but not retention, keep them as demo marketing and do not overbuild them
- if team upgrades start happening naturally, invest harder in team features
- if one segment becomes abusive or low-margin, cut it early

## End State

The end state is:

- personal AI users discover AgentConnect because it is the easiest way to give an agent real capabilities
- a subset become loyal power users
- some bring the workflow into their startup or team
- AgentConnect grows from personal managed access into a broader control plane business

The first wedge is personal and easy. The durable business is personal-to-team expansion with strong safety and margins.

## Reference Links

- [AgentMail pricing](https://www.agentmail.to/pricing)
- [Stripe pricing](https://stripe.com/pricing)
- [Stripe Issuing pricing](https://stripe.com/issuing)
- [Stripe API rate limits](https://docs.stripe.com/rate-limits)
- [Modal pricing](https://modal.com/pricing)
