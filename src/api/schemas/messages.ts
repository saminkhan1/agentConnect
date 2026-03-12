import { z } from 'zod';

export const getMessageParamsSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
});

export const getMessageResponseSchema = z.object({
  message_id: z.string(),
  thread_id: z.string(),
  from: z.string(),
  labels: z.array(z.string()),
  timestamp: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  reply_to: z.array(z.string()),
  subject: z.string().nullable(),
  preview: z.string().nullable(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  headers: z.record(z.string(), z.unknown()),
  in_reply_to: z.string().nullable(),
  references: z.array(z.string()),
  size: z.number().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
