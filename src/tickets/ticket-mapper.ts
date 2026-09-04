import type {
  Category,
  Classification,
  FailureCode,
  Priority,
  Ticket,
  TicketStatus,
} from '../shared/types.js';

export interface TicketRow {
  id: string;
  subject: string;
  body: string;
  status: TicketStatus;
  category: Category | null;
  priority: Priority | null;
  summary: string | null;
  failure_code: string | null;
  classifier_version: string | null;
  prompt_version: string | null;
  classified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function mapTicketRow(row: TicketRow): Ticket {
  const classification: Classification | null =
    row.status === 'classified' &&
    row.category !== null &&
    row.priority !== null &&
    row.summary !== null
      ? {
          category: row.category,
          priority: row.priority,
          summary: row.summary,
        }
      : null;

  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    classification,
    failureCode: (row.failure_code as FailureCode | null) ?? null,
    classifierVersion: row.classifier_version,
    promptVersion: row.prompt_version,
    classifiedAt: row.classified_at ? row.classified_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
