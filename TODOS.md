# TODOS

## Signup funnel instrumentation
**Priority:** P1 (post-launch)
**What:** Add lightweight funnel events: `org.created`, `billing.checkout_started`, `billing.subscription_activated`, `auth.first_success`. Use existing EventWriter with a new system event category.
**Why:** Without funnel visibility, you can't see signup dropoff or checkout abandonment. Existing tables show post-activation usage only. Design doc success metrics ("10 signups") need this data.
**Pros:** Uses existing infrastructure (EventWriter). No third-party analytics. Queryable via events API.
**Cons:** Adds system events to user-visible event log (may need filtering).
**Context:** Codex review flagged weak instrumentation. The `orgs` table gives you signup count, but you can't see WHERE users drop off in the funnel. Query raw DB tables for launch metrics until this is built.
**Depends on:** Nothing — can be built independently.
**Added:** 2026-03-21 (plan-eng-review)

## Stripe.js PAN/CVC reveal documentation
**Priority:** P1 (after Stripe Issuing approval)
**What:** Write a "Card Details Access Guide" with sample code showing how to use `create_card_details_session` with Stripe.js Issuing Elements to reveal PAN/CVC in a frontend.
**Why:** Card issuance returns metadata only. Full card details require the Stripe.js nonce flow. Without a sample, payments are demoable but not self-serve usable.
**Pros:** Makes the payments story actually complete for end users.
**Cons:** Requires a tiny frontend code sample (Stripe.js snippet).
**Context:** The API exists and is tested (`create_card_details_session` in actions.ts). The gap is documentation, not code. The ephemeral key + nonce flow is non-obvious to users who haven't worked with Stripe Issuing before.
**Depends on:** Stripe Issuing approval.
**Added:** 2026-03-21 (plan-eng-review)
