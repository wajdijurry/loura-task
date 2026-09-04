export const TICKET_STATUSES = ['pending', 'classified', 'failed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const CATEGORIES = ['billing', 'technical', 'account', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Stable codes persisted on tickets/jobs. Never includes exception text. */
export const FAILURE_CODES = [
  'MODEL_TIMEOUT',
  'MODEL_UNAVAILABLE',
  'INVALID_MODEL_OUTPUT',
  'WORKER_LOST',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Failure codes produced by the model classification boundary. */
export const MODEL_FAILURE_CODES = [
  'MODEL_TIMEOUT',
  'MODEL_UNAVAILABLE',
  'INVALID_MODEL_OUTPUT',
] as const;
export type ModelFailureCode = (typeof MODEL_FAILURE_CODES)[number];

export const JOB_STATES = ['pending', 'leased', 'completed', 'dead'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const MAX_TICKET_ID_LENGTH = 128;
export const MAX_SUBJECT_LENGTH = 500;
export const MAX_BODY_LENGTH = 20_000;
export const MAX_SUMMARY_LENGTH = 240;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface Classification {
  category: Category;
  priority: Priority;
  summary: string;
}

export interface Ticket {
  id: string;
  subject: string;
  body: string;
  status: TicketStatus;
  classification: Classification | null;
  failureCode: FailureCode | null;
  classifierVersion: string | null;
  promptVersion: string | null;
  classifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClassificationJob {
  id: number;
  ticketId: string;
  state: JobState;
  attemptCount: number;
  nextAvailableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  /** Per-claim fencing token; required for all lease-owned mutations. */
  leaseToken: string | null;
  lastErrorCode: FailureCode | null;
  createdAt: Date;
  updatedAt: Date;
}
