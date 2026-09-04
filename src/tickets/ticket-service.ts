import type { Pool } from 'pg';
import { withTransaction } from '../database/pool.js';
import { JobRepository } from '../jobs/job-repository.js';
import type { Clock } from '../shared/clock.js';
import { ConflictError } from '../shared/errors.js';
import type { Ticket } from '../shared/types.js';
import {
  TicketRepository,
  type CreateTicketInput,
  type ListTicketsFilter,
  type ListTicketsResult,
} from './ticket-repository.js';

export type CreateTicketResult =
  { kind: 'created'; ticket: Ticket } | { kind: 'replayed'; ticket: Ticket };

/**
 * Ticket ingestion with correct concurrent idempotency.
 *
 * In one transaction:
 * - Attempt INSERT ... ON CONFLICT DO NOTHING
 * - If inserted, create exactly one classification job
 * - If conflict: identical subject/body → replay; different → 409
 *
 * Never SELECT-then-INSERT (race-prone under concurrency).
 */
export class TicketService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async createTicket(input: CreateTicketInput): Promise<CreateTicketResult> {
    return withTransaction(this.pool, async (client) => {
      const tickets = new TicketRepository(client);
      const jobs = new JobRepository(client, this.clock);

      const inserted = await tickets.insertPending(input);
      if (inserted) {
        await jobs.insertForTicket(inserted.id);
        return { kind: 'created', ticket: inserted };
      }

      const existing = await tickets.findById(input.id);
      if (!existing) {
        // Extremely unlikely: conflict without a readable row (e.g. concurrent delete).
        throw new Error('Ticket conflict without existing row');
      }

      if (existing.subject === input.subject && existing.body === input.body) {
        return { kind: 'replayed', ticket: existing };
      }

      throw new ConflictError('A ticket with this id already exists with different content', {
        id: input.id,
      });
    });
  }

  async getTicket(id: string): Promise<Ticket | null> {
    const tickets = new TicketRepository(this.pool);
    return tickets.findById(id);
  }

  async listTickets(filter: ListTicketsFilter): Promise<ListTicketsResult> {
    return withTransaction(this.pool, async (client) => {
      const tickets = new TicketRepository(client);
      return tickets.list(filter);
    });
  }
}
