import type Stripe from 'stripe';
import { z } from 'zod';

function createStripeStringUnionSchema<T extends string>(message: string) {
  return z
    .string()
    .trim()
    .min(1, message)
    .transform((value) => value as T);
}

// stripe-node exposes Issuing categories as TypeScript unions, not runtime enums.
// Keep local validation lightweight and let Stripe enforce the exact category set.
export const stripeIssuingAllowedCategorySchema =
  createStripeStringUnionSchema<Stripe.Issuing.CardCreateParams.SpendingControls.AllowedCategory>(
    'must be a Stripe Issuing merchant category value',
  );

export const stripeIssuingBlockedCategorySchema =
  createStripeStringUnionSchema<Stripe.Issuing.CardCreateParams.SpendingControls.BlockedCategory>(
    'must be a Stripe Issuing merchant category value',
  );

export const stripeIssuingSpendingLimitCategorySchema =
  createStripeStringUnionSchema<Stripe.Issuing.CardCreateParams.SpendingControls.SpendingLimit.Category>(
    'must be a Stripe Issuing spending-limit category value',
  );

export const stripeIssuingSpendingLimitIntervals = [
  'all_time',
  'daily',
  'monthly',
  'per_authorization',
  'weekly',
  'yearly',
] as const satisfies readonly Stripe.Issuing.CardCreateParams.SpendingControls.SpendingLimit.Interval[];

export const stripeIssuingSpendingLimitIntervalSchema = z.enum(stripeIssuingSpendingLimitIntervals);

export const stripeIssuingMerchantCountrySchema = z
  .string()
  .trim()
  .transform((value): Stripe.Issuing.CardholderCreateParams.Billing.Address['country'] =>
    value.toUpperCase(),
  )
  .refine((value) => /^[A-Z]{2}$/.test(value), {
    message: 'must be a 2-letter ISO 3166-1 alpha-2 country code',
  });

export const stripeIssuingSpendingLimitSchema = z.object({
  amount: z.number().int().positive(),
  categories: z.array(stripeIssuingSpendingLimitCategorySchema).optional(),
  interval: stripeIssuingSpendingLimitIntervalSchema,
});
