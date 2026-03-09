import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const emailAddressListSchema = z.array(nonEmptyStringSchema).optional();

export const eventTypeValues = [
  'email.sent',
  'email.received',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.rejected',
  'payment.card.issued',
  'payment.card.authorized',
  'payment.card.declined',
  'payment.card.settled',
] as const;

export const EVENT_TYPES = {
  EMAIL_SENT: 'email.sent',
  EMAIL_RECEIVED: 'email.received',
  EMAIL_DELIVERED: 'email.delivered',
  EMAIL_BOUNCED: 'email.bounced',
  EMAIL_COMPLAINED: 'email.complained',
  EMAIL_REJECTED: 'email.rejected',
  PAYMENT_CARD_ISSUED: 'payment.card.issued',
  PAYMENT_CARD_AUTHORIZED: 'payment.card.authorized',
  PAYMENT_CARD_DECLINED: 'payment.card.declined',
  PAYMENT_CARD_SETTLED: 'payment.card.settled',
} as const;

export const eventTypeSchema = z.enum(eventTypeValues);

const emailBaseDataSchema = z
  .object({
    message_id: nonEmptyStringSchema,
    thread_id: optionalNonEmptyStringSchema,
    subject: optionalNonEmptyStringSchema,
    from: optionalNonEmptyStringSchema,
    to: emailAddressListSchema,
    cc: emailAddressListSchema,
    bcc: emailAddressListSchema,
  })
  .loose();

const cardMoneySchema = z
  .object({
    amount: z.number().nonnegative(),
    currency: nonEmptyStringSchema.regex(
      /^[A-Z]{3}$/,
      'currency must be a 3-letter uppercase code',
    ),
  })
  .loose();

const settledCardMoneySchema = z
  .object({
    amount: z.number(),
    currency: nonEmptyStringSchema.regex(
      /^[A-Z]{3}$/,
      'currency must be a 3-letter uppercase code',
    ),
  })
  .loose();

export const eventDataSchemas = {
  [EVENT_TYPES.EMAIL_SENT]: emailBaseDataSchema,
  [EVENT_TYPES.EMAIL_RECEIVED]: emailBaseDataSchema,
  [EVENT_TYPES.EMAIL_DELIVERED]: z
    .object({
      message_id: nonEmptyStringSchema,
      thread_id: optionalNonEmptyStringSchema,
    })
    .loose(),
  [EVENT_TYPES.EMAIL_BOUNCED]: z
    .object({
      message_id: nonEmptyStringSchema,
      thread_id: optionalNonEmptyStringSchema,
      reason: optionalNonEmptyStringSchema,
    })
    .loose(),
  [EVENT_TYPES.EMAIL_COMPLAINED]: z
    .object({
      message_id: nonEmptyStringSchema,
      thread_id: optionalNonEmptyStringSchema,
      reason: optionalNonEmptyStringSchema,
    })
    .loose(),
  [EVENT_TYPES.EMAIL_REJECTED]: z
    .object({
      message_id: nonEmptyStringSchema,
      thread_id: optionalNonEmptyStringSchema,
      reason: optionalNonEmptyStringSchema,
    })
    .loose(),
  [EVENT_TYPES.PAYMENT_CARD_ISSUED]: z
    .object({
      card_id: nonEmptyStringSchema,
    })
    .loose(),
  [EVENT_TYPES.PAYMENT_CARD_AUTHORIZED]: cardMoneySchema
    .extend({
      authorization_id: nonEmptyStringSchema,
      transaction_id: optionalNonEmptyStringSchema,
    })
    .loose(),
  [EVENT_TYPES.PAYMENT_CARD_DECLINED]: cardMoneySchema
    .extend({
      authorization_id: nonEmptyStringSchema,
      transaction_id: optionalNonEmptyStringSchema,
    })
    .loose(),
  [EVENT_TYPES.PAYMENT_CARD_SETTLED]: settledCardMoneySchema
    .extend({
      transaction_id: nonEmptyStringSchema,
      authorization_id: optionalNonEmptyStringSchema,
    })
    .loose(),
} as const;

export type EventType = z.infer<typeof eventTypeSchema>;
export type EventData = Record<string, unknown>;

export function validateEventData(eventType: EventType, data: unknown): EventData {
  return eventDataSchemas[eventType].parse(data) as EventData;
}
