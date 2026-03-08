import { z } from 'zod';

import { eventResponseSchema } from './events';

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
