# Phase E Review

**Branch:** `phaseE` (3 commits vs `main`)
**Tests:** 153/153 pass | **Build:** pass | **Lint:** clean

## Must Fix

### 1. `transitionState` has no current-state guard
**`src/db/dal.ts`** — UPDATE runs without `WHERE state = $current`. Any caller bug silently corrupts the state machine.
**Fix:** Add `WHERE state = $expectedCurrent` and return row count so callers detect stale transitions.

### 2. Ephemeral key leaked in MCP text content
**`src/mcp/tools/payments.ts`** — `create_card_details_session` previously filtered `ephemeral_key_secret` from text output via `safeSession`. Unstaged changes removed that filter.
**Fix:** Restore `safeSession` filtering for text content.

### 3. DNS rebinding on webhook delivery
**`src/domain/outbound-webhooks.ts`** — `assertSafeHostname` runs only at subscription creation. At delivery time, attacker-controlled DNS can resolve to internal IPs.
**Fix:** Re-validate resolved IP at fetch time or pin the resolved IP at creation.

## Should Fix

### 4. `findByIdempotencyKey` ignores action type
**`src/db/dal.ts`** — Unique constraint is `(org_id, action, idempotency_key)` but query omits `action`. Could return wrong row if same key used across action types.
**Fix:** Add `action` filter to the query.

### 5. `withTimeout` signal unused
**`src/api/routes/outbound-email-actions.ts`** — All `withTimeout` callers ignore the `AbortSignal`. Timed-out adapter calls continue silently. Safe for idempotent paths; risky for direct (no-key) sends.
**Fix:** Pass signal to adapter calls, or accept as known behavior.

## Informational

- **Wildcard `allowed_domains`** (`src/domain/policy.ts`) — `["*"]` now allows all domains. Intentional feature, has test coverage.
- **Retry on 401** (`src/domain/outbound-webhooks.ts:791`) — Unusual but capped at 3 retries. Intentional for OpenClaw integration.
- **Unstaged changes** are tooling migration (Prettier/ESLint to Biome, tsc to tsup) + deployment infra (Dockerfile, railway.toml). No other hidden functional changes.
