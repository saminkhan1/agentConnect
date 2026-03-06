import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db';
import { events } from '../db/schema';
import { eventTypeSchema, type EventType, validateEventData } from './events';

type EventRecord = typeof events.$inferSelect;
type DatabaseClient = typeof db;
type DatabaseTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
type DbExecutor = DatabaseClient | DatabaseTransaction;

type RawWriteEventInput = {
  orgId: string;
  agentId: string;
  resourceId?: string | null;
  provider: string;
  providerEventId?: string | null;
  eventType: EventType;
  occurredAt?: Date | string;
  idempotencyKey?: string | null;
  data: unknown;
};

export type WriteEventInput = RawWriteEventInput;
export type WriteEventResult = {
  event: EventRecord;
  wasCreated: boolean;
};
export type IngestProviderEventInput = Omit<RawWriteEventInput, 'provider'>;

const optionalNonEmptyStringSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length === 0 ? undefined : trimmedValue;
}, z.string().min(1).nullable().optional());

const isoDateTimeStringSchema = z.iso.datetime({ offset: true }).refine((value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    return false;
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}, 'Invalid occurredAt timestamp');

const writeEventInputSchema = z.object({
  orgId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  resourceId: optionalNonEmptyStringSchema,
  provider: z.string().trim().min(1),
  providerEventId: optionalNonEmptyStringSchema,
  eventType: eventTypeSchema,
  occurredAt: z.union([z.date(), isoDateTimeStringSchema]).optional(),
  idempotencyKey: optionalNonEmptyStringSchema,
  data: z.unknown(),
});

function normalizeOccurredAt(value?: Date | string): Date {
  if (!value) {
    return new Date();
  }

  if (value instanceof Date) {
    return value;
  }

  return new Date(value);
}

function parseWriteEventInput(input: RawWriteEventInput) {
  const parsedInput = writeEventInputSchema.parse(input);

  return {
    ...parsedInput,
    occurredAt: normalizeOccurredAt(parsedInput.occurredAt),
    data: validateEventData(parsedInput.eventType, parsedInput.data),
  };
}

export class EventWriter {
  async writeEvent(input: WriteEventInput): Promise<WriteEventResult> {
    return this.writeWithExecutor(db, input);
  }

  async ingestProviderEvents(
    provider: string,
    items: IngestProviderEventInput[],
  ): Promise<WriteEventResult[]> {
    const normalizedProvider = z.string().trim().min(1).parse(provider);

    if (items.length === 0) {
      return [];
    }

    return db.transaction(async (tx) => {
      const results: WriteEventResult[] = [];

      for (const item of items) {
        results.push(
          await this.writeWithExecutor(tx, {
            ...item,
            provider: normalizedProvider,
          }),
        );
      }

      return results;
    });
  }

  private async writeWithExecutor(
    dbExecutor: DbExecutor,
    input: WriteEventInput,
  ): Promise<WriteEventResult> {
    const parsedInput = parseWriteEventInput(input);
    const insertedRows = await dbExecutor
      .insert(events)
      .values({
        id: crypto.randomUUID(),
        orgId: parsedInput.orgId,
        agentId: parsedInput.agentId,
        resourceId: parsedInput.resourceId,
        provider: parsedInput.provider,
        providerEventId: parsedInput.providerEventId,
        eventType: parsedInput.eventType,
        occurredAt: parsedInput.occurredAt,
        idempotencyKey: parsedInput.idempotencyKey,
        data: parsedInput.data,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRows[0]) {
      return {
        event: insertedRows[0],
        wasCreated: true,
      };
    }

    const existingEvent = await this.findExistingDuplicate(dbExecutor, parsedInput);
    if (!existingEvent) {
      throw new Error('Insert was skipped without a matching dedupe key');
    }

    return {
      event: existingEvent,
      wasCreated: false,
    };
  }

  private async findExistingDuplicate(
    dbExecutor: DbExecutor,
    input: ReturnType<typeof parseWriteEventInput>,
  ): Promise<EventRecord | null> {
    const providerMatch = input.providerEventId
      ? await dbExecutor
          .select()
          .from(events)
          .where(
            and(
              eq(events.orgId, input.orgId),
              eq(events.provider, input.provider),
              eq(events.providerEventId, input.providerEventId),
            ),
          )
          .limit(1)
      : [];

    const idempotencyMatch = input.idempotencyKey
      ? await dbExecutor
          .select()
          .from(events)
          .where(
            and(eq(events.orgId, input.orgId), eq(events.idempotencyKey, input.idempotencyKey)),
          )
          .limit(1)
      : [];

    const existingByProvider = providerMatch.at(0) ?? null;
    const existingByIdempotency = idempotencyMatch.at(0) ?? null;

    if (
      existingByProvider !== null &&
      existingByIdempotency !== null &&
      existingByProvider.id !== existingByIdempotency.id
    ) {
      throw new Error('Conflicting event dedupe keys map to different events');
    }

    if (existingByProvider !== null) {
      return existingByProvider;
    }

    if (existingByIdempotency !== null) {
      return existingByIdempotency;
    }

    return null;
  }
}
