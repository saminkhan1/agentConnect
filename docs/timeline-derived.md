# Derived Timeline API

`GET /agents/:id/timeline` exposes a unified activity feed derived directly from the canonical `events` table. Phase D2 keeps this read path projection-free on purpose: no new tables, no projector worker, no migration.

## Query Parameters

- `since` and `until`: optional ISO 8601 datetimes, inclusive bounds on `occurredAt`
- `limit`: optional page size, defaults to `50`, max `100`
- `cursor`: opaque pagination cursor returned by the previous page

The route requires `agents:read` and returns `404` only when the scoped agent does not exist.

## Item Kinds

Timeline items are grouped on read and returned as `{ items, nextCursor }`.

- `email_thread`: groups email events with the same non-empty `data.thread_id`
- `card_activity`: groups `payment.card.authorized`, `payment.card.declined`, and `payment.card.settled` by `coalesce(data.authorization_id, data.transaction_id)`
- `event`: singleton fallback for anything without a usable grouping key, including `payment.card.issued` and email events without `thread_id`

Each item contains:

- `id`, `kind`, `groupKey`
- `occurredAt`, `startedAt`, `eventCount`
- `resourceId`, `provider`, `latestEventType`
- `summary`
- `events` ordered newest-first using the existing event response shape

## Pagination Semantics

Pagination is item-based, not event-based.

The query first derives grouping keys, then pages grouped items by `(occurredAt desc, id desc)`, then fetches the full event rows for those selected groups. This prevents a single thread or purchase from being split across pages.

## Phase E Reuse

Phase E should reuse this exact item contract for `agentinfra.timeline.list`. MCP should not define a second timeline schema.

## When To Add Projected Tables

Keep the derived implementation until one of these becomes true:

- timeline queries become a measurable p95 hotspot
- grouping rules become more complex than simple SQL derivation
- you need richer precomputed rollups or denormalized search fields

At that point, add `timeline_items` projection tables plus a worker-backed projector, but keep the public response schema unchanged.
