import type { DbClient } from '../database/pool.js';
import { query } from '../database/pool.js';
import type { Category, Classification, FailureCode, Priority } from '../shared/types.js';
import { mapTicketRow, type TicketRow } from './ticket-mapper.js';
import type { Ticket } from '../shared/types.js';

export interface CreateTicketInput {
  id: string;
  subject: string;
  body: string;
}

export interface ListTicketsFilter {
  category?: Category;
  priority?: Priority;
  page: number;
  pageSize: number;
}

export interface ListTicketsResult {
  tickets: Ticket[];
  total: number;
  page: number;
  pageSize: number;
}

export class TicketRepository {
  constructor(private readonly db: DbClient) {}

  async insertPending(input: CreateTicketInput): Promise<Ticket | null> {
    const result = await query<TicketRow>(
      this.db,
      `
      INSERT INTO tickets (id, subject, body, status)
      VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (id) DO NOTHING
      RETURNING *
      `,
      [input.id, input.subject, input.body],
    );
    const row = result.rows[0];
    return row ? mapTicketRow(row) : null;
  }

  async findById(id: string): Promise<Ticket | null> {
    const result = await query<TicketRow>(this.db, `SELECT * FROM tickets WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapTicketRow(row) : null;
  }

  async list(filter: ListTicketsFilter): Promise<ListTicketsResult> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.category !== undefined) {
      params.push(filter.category);
      conditions.push(`category = $${params.length}`);
    }
    if (filter.priority !== undefined) {
      params.push(filter.priority);
      conditions.push(`priority = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<{ count: string }>(
      this.db,
      `SELECT COUNT(*)::text AS count FROM tickets ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? 0);

    const offset = (filter.page - 1) * filter.pageSize;
    params.push(filter.pageSize);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    const listResult = await query<TicketRow>(
      this.db,
      `
      SELECT *
      FROM tickets
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
      `,
      params,
    );

    return {
      tickets: listResult.rows.map(mapTicketRow),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }

  async markClassified(input: {
    ticketId: string;
    classification: Classification;
    classifierVersion: string;
    promptVersion: string;
    classifiedAt: Date;
  }): Promise<boolean> {
    const result = await query(
      this.db,
      `
      UPDATE tickets
      SET
        status = 'classified',
        category = $2,
        priority = $3,
        summary = $4,
        failure_code = NULL,
        classifier_version = $5,
        prompt_version = $6,
        classified_at = $7,
        updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      `,
      [
        input.ticketId,
        input.classification.category,
        input.classification.priority,
        input.classification.summary,
        input.classifierVersion,
        input.promptVersion,
        input.classifiedAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markFailed(input: { ticketId: string; failureCode: FailureCode }): Promise<boolean> {
    const result = await query(
      this.db,
      `
      UPDATE tickets
      SET
        status = 'failed',
        category = NULL,
        priority = NULL,
        summary = NULL,
        failure_code = $2,
        classifier_version = NULL,
        prompt_version = NULL,
        classified_at = NULL,
        updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      `,
      [input.ticketId, input.failureCode],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
