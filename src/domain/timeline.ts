import { z } from 'zod';

import { events as eventsTable } from '../db/schema';
import type { EventType } from './events';

export const timelineItemKindValues = ['email_thread', 'card_activity', 'event'] as const;
export const timelineItemKindSchema = z.enum(timelineItemKindValues);

export type TimelineItemKind = z.infer<typeof timelineItemKindSchema>;
type EventRecord = typeof eventsTable.$inferSelect;

type EmailThreadSummary = {
  threadId: string;
  subject: string | null;
  from: string | null;
  to: string[];
};

type CardActivitySummary = {
  authorizationId: string | null;
  transactionId: string | null;
  amount: number | null;
  currency: string | null;
};

type EventSummary = {
  eventType: EventType;
};

export type TimelineSummary =
  | { kind: 'email_thread'; value: EmailThreadSummary }
  | { kind: 'card_activity'; value: CardActivitySummary }
  | { kind: 'event'; value: EventSummary };

export type TimelineItem = {
  id: string;
  kind: TimelineItemKind;
  groupKey: string;
  occurredAt: Date;
  startedAt: Date;
  eventCount: number;
  resourceId: string | null;
  provider: string;
  latestEventType: EventType;
  summary: TimelineSummary;
  events: EventRecord[];
};

export type TimelineCursor = {
  occurredAt: Date;
  id: string;
};

const timelineItemIdPayloadSchema = z.tuple([timelineItemKindSchema, z.string().min(1)]);
const timelineCursorSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }),
  id: z.string().trim().min(1),
});

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter((entry): entry is string =>
    isNonEmptyString(entry),
  );
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sortEventsDescending(events: EventRecord[]): EventRecord[] {
  return [...events].sort((left, right) => {
    const occurredAtDiff = right.occurredAt.getTime() - left.occurredAt.getTime();
    if (occurredAtDiff !== 0) {
      return occurredAtDiff;
    }

    return right.id.localeCompare(left.id);
  });
}

function buildEmailThreadSummary(groupKey: string, sortedEvents: EventRecord[]): TimelineSummary {
  let subject: string | null = null;
  let from: string | null = null;
  const toSeen = new Set<string>();

  for (const event of sortedEvents) {
    if (subject === null) subject = readString(event.data['subject']);
    if (from === null) from = readString(event.data['from']);
    for (const addr of readStringArray(event.data['to'])) toSeen.add(addr);
  }

  return {
    kind: 'email_thread',
    value: {
      threadId: groupKey,
      subject,
      from,
      to: [...toSeen],
    },
  };
}

function buildCardActivitySummary(sortedEvents: EventRecord[]): TimelineSummary {
  const authorizationId = sortedEvents
    .map((event) => readString(event.data['authorization_id']))
    .find((value): value is string => value !== null);
  const transactionId = sortedEvents
    .map((event) => readString(event.data['transaction_id']))
    .find((value): value is string => value !== null);
  const amount = sortedEvents
    .map((event) => readNumber(event.data['amount']))
    .find((value): value is number => value !== null);
  const currency = sortedEvents
    .map((event) => readString(event.data['currency']))
    .find((value): value is string => value !== null);

  return {
    kind: 'card_activity',
    value: {
      authorizationId: authorizationId ?? null,
      transactionId: transactionId ?? null,
      amount: amount ?? null,
      currency: currency ?? null,
    },
  };
}

function buildEventSummary(eventType: EventType): TimelineSummary {
  return {
    kind: 'event',
    value: {
      eventType,
    },
  };
}

export function encodeTimelineItemId(kind: TimelineItemKind, groupKey: string): string {
  return Buffer.from(JSON.stringify([kind, groupKey])).toString('base64url');
}

export function encodeTimelineCursor(item: Pick<TimelineItem, 'id' | 'occurredAt'>): string {
  return Buffer.from(
    JSON.stringify({
      occurredAt: item.occurredAt.toISOString(),
      id: item.id,
    }),
  ).toString('base64url');
}

export function decodeTimelineItemId(
  id: string,
): { kind: TimelineItemKind; groupKey: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as unknown;
    const result = timelineItemIdPayloadSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }

    return {
      kind: result.data[0],
      groupKey: result.data[1],
    };
  } catch {
    return null;
  }
}

export function decodeTimelineCursor(cursor: string): TimelineCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const result = timelineCursorSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }

    const occurredAt = new Date(result.data.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      return null;
    }

    if (!decodeTimelineItemId(result.data.id)) {
      return null;
    }

    return { occurredAt, id: result.data.id };
  } catch {
    return null;
  }
}

export function buildTimelineItem(
  kind: TimelineItemKind,
  groupKey: string,
  groupedEvents: EventRecord[],
  itemId = encodeTimelineItemId(kind, groupKey),
): TimelineItem {
  if (groupedEvents.length === 0) {
    throw new Error('Cannot build a timeline item without events');
  }

  const events = sortEventsDescending(groupedEvents);
  const latestEvent = events[0];
  const earliestEvent = events[events.length - 1];

  let summary: TimelineSummary;
  if (kind === 'email_thread') {
    summary = buildEmailThreadSummary(groupKey, events);
  } else if (kind === 'card_activity') {
    summary = buildCardActivitySummary(events);
  } else {
    summary = buildEventSummary(latestEvent.eventType);
  }

  return {
    id: itemId,
    kind,
    groupKey,
    occurredAt: latestEvent.occurredAt,
    startedAt: earliestEvent.occurredAt,
    eventCount: events.length,
    resourceId: latestEvent.resourceId ?? null,
    provider: latestEvent.provider,
    latestEventType: latestEvent.eventType,
    summary,
    events,
  };
}
