import { z } from 'zod';
import {
  CATEGORIES,
  DEFAULT_PAGE_SIZE,
  MAX_BODY_LENGTH,
  MAX_PAGE_SIZE,
  MAX_SUBJECT_LENGTH,
  MAX_TICKET_ID_LENGTH,
  PRIORITIES,
} from '../shared/types.js';

export const createTicketBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(MAX_TICKET_ID_LENGTH)
      .regex(/^[A-Za-z0-9._:-]+$/, 'id contains invalid characters'),
    subject: z.string().max(MAX_SUBJECT_LENGTH),
    body: z.string().min(1).max(MAX_BODY_LENGTH),
  })
  .strict();

const safePageInt = z.coerce.number().int().positive().max(1_000_000, 'page is too large');

export const listTicketsQuerySchema = z
  .object({
    category: z.enum(CATEGORIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    page: safePageInt.default(1),
    pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export const ticketIdParamSchema = z
  .object({
    id: z.string().min(1).max(MAX_TICKET_ID_LENGTH),
  })
  .strict();
