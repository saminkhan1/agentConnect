import { z } from 'zod';

import { eventResponseSchema } from './events';
import { resourceResponseSchema } from './resources';
import {
  stripeIssuingAllowedCategorySchema,
  stripeIssuingMerchantCountrySchema,
} from '../../domain/stripe-issuing';

export const sendEmailParamsSchema = z.object({ id: z.string().min(1) });

export const sendEmailBodySchema = z.object({
  to: z.array(z.email()).min(1),
  subject: z.string().min(1),
  text: z.string(),
  html: z.string().optional(),
  cc: z.array(z.email()).optional(),
  bcc: z.array(z.email()).optional(),
  reply_to: z.email().optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const sendEmailResponseSchema = z.object({ event: eventResponseSchema });

// ---------------------------------------------------------------------------
// issue_card
// ---------------------------------------------------------------------------

export const issueCardParamsSchema = z.object({ id: z.string().min(1) });

const spendingLimitSchema = z.object({
  amount: z.number().int().positive().max(1_000_000), // max 10,000 USD in cents
  interval: z.enum(['per_authorization', 'daily', 'weekly', 'monthly']),
});

export const issueCardBodySchema = z.object({
  spending_limits: z.array(spendingLimitSchema).min(1),
  allowed_categories: z.array(stripeIssuingAllowedCategorySchema).optional(),
  allowed_merchant_countries: z.array(stripeIssuingMerchantCountrySchema).optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const issueCardResponseSchema = z.object({
  resource: resourceResponseSchema,
  card: z.object({
    number: z.string().nullable(),
    cvc: z.string().nullable(),
    exp_month: z.number().int(),
    exp_year: z.number().int(),
    last4: z.string(),
  }),
  event: eventResponseSchema,
});
