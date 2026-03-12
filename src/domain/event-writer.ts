import crypto from 'node:crypto';

import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db';
import { events } from '../db/schema';
import { eventTypeSchema, type EventType, validateEventData } from './events';
import { sleep } from '../adapters/provider-client';

type EventRecord = typeof events.$inferSelect;
type DatabaseClient = typeof db;
type DatabaseTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
type ParsedWriteEventInput = ReturnType<typeof parseWriteEventInput>;
type DuplicateMatches = {
  byProvider: EventRecord | null;
  byIdempotency: EventRecord | null;
};
type EventWriterOptions = {
  onEventCreated?: (dbExecutor: DatabaseTransaction, event: EventRecord) => Promise<void>;
};

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
export type EventWriterExecutor = DatabaseTransaction;
export const MAX_INGEST_BATCH_SIZE = 100;

const RETRYABLE_PG_ERROR_CODES = new Set(['40001', '40P01']);
const DEDUPE_CONSTRAINT_NAMES = new Set([
  'events_org_provider_provider_event_id_unique',
  'events_org_idempotency_key_unique',
]);
const MAX_WRITE_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 10;

export class EventWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EventBatchTooLargeError extends EventWriterError {
  readonly code = 'EVENT_BATCH_TOO_LARGE';
  readonly batchSize: number;
  readonly maxBatchSize: number;

  constructor(batchSize: number, maxBatchSize: number) {
    super(
      `Cannot ingest more than ${String(maxBatchSize)} events in one batch (received ${String(batchSize)})`,
    );
    this.batchSize = batchSize;
    this.maxBatchSize = maxBatchSize;
  }
}

export class EventDedupeConflictError extends EventWriterError {
  readonly code = 'EVENT_DEDUPE_CONFLICT';
}

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

const writeEventInputSchema = z.object({
  orgId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  resourceId: optionalNonEmptyStringSchema,
  provider: z.string().trim().min(1),
  providerEventId: optionalNonEmptyStringSchema,
  eventType: eventTypeSchema,
  occurredAt: z.union([z.date(), z.iso.datetime({ offset: true })]).optional(),
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractPgErrorMetadata(error: unknown): { code?: string; constraint?: string } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let code: string | undefined;
  let constraint: string | undefined;

  while (isObjectRecord(current) && !seen.has(current)) {
    seen.add(current);

    if (!code && typeof current.code === 'string') {
      code = current.code;
    }

    if (!constraint && typeof current.constraint === 'string') {
      constraint = current.constraint;
    }

    current = current.cause;
  }

  return { code, constraint };
}

function isRetryableWriteError(error: unknown): boolean {
  const { code, constraint } = extractPgErrorMetadata(error);
  if (!code) {
    return false;
  }

  if (RETRYABLE_PG_ERROR_CODES.has(code)) {
    return true;
  }

  return code === '23505' && constraint !== undefined && DEDUPE_CONSTRAINT_NAMES.has(constraint);
}

function isPresent(value: string | null | undefined): value is string {
  return value !== undefined && value !== null;
}

function uniqueNonNullValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter(isPresent))];
}

function getRetryDelayMs(attempt: number): number {
  const exponentialDelay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
  return exponentialDelay + jitter;
}

export class EventWriter {
  constructor(private readonly options: EventWriterOptions = {}) {}

  async writeEvent(input: WriteEventInput): Promise<WriteEventResult> {
    return this.withWriteRetries(async () => {
      return db.transaction(async (tx) => this.writeWithExecutor(tx, input));
    });
  }

  async ingestProviderEvents(
    provider: string,
    items: IngestProviderEventInput[],
  ): Promise<WriteEventResult[]> {
    const normalizedProvider = z.string().trim().min(1).parse(provider);

    if (items.length === 0) {
      return [];
    }

    if (items.length > MAX_INGEST_BATCH_SIZE) {
      throw new EventBatchTooLargeError(items.length, MAX_INGEST_BATCH_SIZE);
    }

    return this.withWriteRetries(async () => {
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
    });
  }

  private async withWriteRetries<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_WRITE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === MAX_WRITE_RETRY_ATTEMPTS || !isRetryableWriteError(error)) {
          throw error;
        }

        await sleep(getRetryDelayMs(attempt));
      }
    }

    throw new EventWriterError('Unexpected retry loop termination');
  }

  private async writeWithExecutor(
    dbExecutor: DatabaseTransaction,
    input: WriteEventInput,
  ): Promise<WriteEventResult> {
    const parsedInput = parseWriteEventInput(input);
    await this.acquireDedupeLocks(dbExecutor, parsedInput);

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
      if (this.options.onEventCreated) {
        await this.options.onEventCreated(dbExecutor, insertedRows[0]);
      }

      return {
        event: insertedRows[0],
        wasCreated: true,
      };
    }

    const duplicateMatches = await this.findDuplicateMatches(dbExecutor, parsedInput);
    if (
      duplicateMatches.byProvider !== null &&
      duplicateMatches.byIdempotency !== null &&
      duplicateMatches.byProvider.id !== duplicateMatches.byIdempotency.id
    ) {
      const reconciledEvent = await this.reconcileDuplicateMatches(
        dbExecutor,
        duplicateMatches.byProvider,
        duplicateMatches.byIdempotency,
        parsedInput,
      );

      return {
        event: reconciledEvent,
        wasCreated: false,
      };
    }

    const existingEvent = duplicateMatches.byProvider ?? duplicateMatches.byIdempotency;
    if (!existingEvent) {
      throw new EventDedupeConflictError('Insert was skipped without a matching dedupe key');
    }

    const mergedEvent = await this.mergeMissingDedupeKeys(dbExecutor, existingEvent, parsedInput);

    return {
      event: mergedEvent,
      wasCreated: false,
    };
  }

  private async acquireDedupeLocks(
    dbExecutor: DatabaseTransaction,
    input: ParsedWriteEventInput,
  ): Promise<void> {
    const lockKeys: string[] = [];
    if (isPresent(input.providerEventId)) {
      lockKeys.push(`events:${input.orgId}:provider:${input.provider}:${input.providerEventId}`);
    }
    if (isPresent(input.idempotencyKey)) {
      lockKeys.push(`events:${input.orgId}:idempotency:${input.idempotencyKey}`);
    }

    lockKeys.sort();

    for (const lockKey of lockKeys) {
      await dbExecutor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    }
  }

  private async findDuplicateMatches(
    dbExecutor: DatabaseTransaction,
    input: ParsedWriteEventInput,
  ): Promise<DuplicateMatches> {
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

    return {
      byProvider: providerMatch.at(0) ?? null,
      byIdempotency: idempotencyMatch.at(0) ?? null,
    };
  }

  private pickCanonicalEvent(left: EventRecord, right: EventRecord): EventRecord {
    const ingestedAtDifference = left.ingestedAt.getTime() - right.ingestedAt.getTime();
    if (ingestedAtDifference < 0) {
      return left;
    }
    if (ingestedAtDifference > 0) {
      return right;
    }

    return left.id.localeCompare(right.id) <= 0 ? left : right;
  }

  private resolveDedupeValue(
    fieldName: 'providerEventId' | 'idempotencyKey',
    values: Array<string | null | undefined>,
  ): string | null {
    const uniqueValues = uniqueNonNullValues(values);
    if (uniqueValues.length > 1) {
      throw new EventDedupeConflictError(
        `Conflicting ${fieldName} values map to different canonical events`,
      );
    }

    return uniqueValues[0] ?? null;
  }

  private async reconcileDuplicateMatches(
    dbExecutor: DatabaseTransaction,
    providerMatch: EventRecord,
    idempotencyMatch: EventRecord,
    input: ParsedWriteEventInput,
  ): Promise<EventRecord> {
    const lockedRows = await dbExecutor
      .select()
      .from(events)
      .where(
        and(
          eq(events.orgId, input.orgId),
          or(eq(events.id, providerMatch.id), eq(events.id, idempotencyMatch.id)),
        ),
      )
      .for('update');

    const byId = new Map(lockedRows.map((row) => [row.id, row]));
    const lockedProvider = byId.get(providerMatch.id) ?? null;
    const lockedIdempotency = byId.get(idempotencyMatch.id) ?? null;
    if (!lockedProvider || !lockedIdempotency) {
      const remainingEvent = lockedProvider ?? lockedIdempotency;
      if (!remainingEvent) {
        throw new EventDedupeConflictError('Unable to reconcile conflicting event dedupe keys');
      }

      return this.mergeMissingDedupeKeys(dbExecutor, remainingEvent, input);
    }

    const canonicalEvent = this.pickCanonicalEvent(lockedProvider, lockedIdempotency);
    const duplicateEvent =
      canonicalEvent.id === lockedProvider.id ? lockedIdempotency : lockedProvider;

    const resolvedProviderEventId = this.resolveDedupeValue('providerEventId', [
      canonicalEvent.providerEventId,
      duplicateEvent.providerEventId,
      input.providerEventId,
    ]);
    const resolvedIdempotencyKey = this.resolveDedupeValue('idempotencyKey', [
      canonicalEvent.idempotencyKey,
      duplicateEvent.idempotencyKey,
      input.idempotencyKey,
    ]);

    await dbExecutor
      .delete(events)
      .where(and(eq(events.orgId, duplicateEvent.orgId), eq(events.id, duplicateEvent.id)));

    const updates: { providerEventId?: string; idempotencyKey?: string } = {};
    if (canonicalEvent.providerEventId === null && resolvedProviderEventId !== null) {
      updates.providerEventId = resolvedProviderEventId;
    }
    if (canonicalEvent.idempotencyKey === null && resolvedIdempotencyKey !== null) {
      updates.idempotencyKey = resolvedIdempotencyKey;
    }

    if (Object.keys(updates).length === 0) {
      return canonicalEvent;
    }

    const updatedRows = await dbExecutor
      .update(events)
      .set(updates)
      .where(and(eq(events.orgId, canonicalEvent.orgId), eq(events.id, canonicalEvent.id)))
      .returning();
    if (updatedRows.length === 0) {
      throw new EventDedupeConflictError('Failed to reconcile conflicting event dedupe keys');
    }

    return updatedRows[0];
  }

  private async mergeMissingDedupeKeys(
    dbExecutor: DatabaseTransaction,
    existingEvent: EventRecord,
    input: ParsedWriteEventInput,
  ): Promise<EventRecord> {
    const lockedRows = await dbExecutor
      .select()
      .from(events)
      .where(and(eq(events.orgId, existingEvent.orgId), eq(events.id, existingEvent.id)))
      .for('update')
      .limit(1);
    if (lockedRows.length === 0) {
      return existingEvent;
    }
    const lockedEvent = lockedRows[0];

    const updates: { providerEventId?: string; idempotencyKey?: string } = {};
    if (lockedEvent.providerEventId === null && isPresent(input.providerEventId)) {
      updates.providerEventId = input.providerEventId;
    }

    if (lockedEvent.idempotencyKey === null && isPresent(input.idempotencyKey)) {
      updates.idempotencyKey = input.idempotencyKey;
    }

    if (Object.keys(updates).length === 0) {
      return lockedEvent;
    }

    const updatedRows = await dbExecutor
      .update(events)
      .set(updates)
      .where(and(eq(events.orgId, lockedEvent.orgId), eq(events.id, lockedEvent.id)))
      .returning();
    if (updatedRows.length === 0) {
      throw new EventDedupeConflictError('Failed to merge dedupe keys into canonical event');
    }

    return updatedRows[0];
  }
}
