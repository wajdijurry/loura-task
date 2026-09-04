import type { DbClient } from '../database/pool.js';
import { query } from '../database/pool.js';
import type { Clock } from '../shared/clock.js';
import type { ClassificationJob, FailureCode, JobState } from '../shared/types.js';

interface JobRow {
  id: string;
  ticket_id: string;
  state: JobState;
  attempt_count: number;
  next_available_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  lease_token: string | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapJobRow(row: JobRow): ClassificationJob {
  return {
    id: Number(row.id),
    ticketId: row.ticket_id,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAvailableAt: row.next_available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    leaseToken: row.lease_token,
    lastErrorCode: (row.last_error_code as FailureCode | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobRepository {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async insertForTicket(ticketId: string): Promise<ClassificationJob> {
    const result = await query<JobRow>(
      this.db,
      `
      INSERT INTO classification_jobs (ticket_id, state, attempt_count, next_available_at)
      VALUES ($1, 'pending', 0, $2)
      RETURNING *
      `,
      [ticketId, this.clock.now()],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to insert classification job');
    }
    return mapJobRow(row);
  }

  /**
   * Recover expired leases using PostgreSQL NOW().
   * attempt_count already counts started executions (incremented on claim):
   * - remaining attempts → requeue pending with WORKER_LOST
   * - final attempt lost → dead job + failed ticket atomically
   */
  async reclaimExpiredLeases(maxAttempts: number): Promise<{ requeued: number; failed: number }> {
    const requeued = await query(
      this.db,
      `
      UPDATE classification_jobs
      SET
        state = 'pending',
        lease_owner = NULL,
        lease_expires_at = NULL,
        lease_token = NULL,
        last_error_code = 'WORKER_LOST',
        updated_at = NOW()
      WHERE state = 'leased'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < NOW()
        AND attempt_count < $1
      `,
      [maxAttempts],
    );

    const failedJobs = await query<{ id: string; ticket_id: string }>(
      this.db,
      `
      WITH expired AS (
        SELECT id, ticket_id
        FROM classification_jobs
        WHERE state = 'leased'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < NOW()
          AND attempt_count >= $1
        FOR UPDATE
      ),
      dead AS (
        UPDATE classification_jobs AS j
        SET
          state = 'dead',
          lease_owner = NULL,
          lease_expires_at = NULL,
          lease_token = NULL,
          last_error_code = 'WORKER_LOST',
          updated_at = NOW()
        FROM expired
        WHERE j.id = expired.id
        RETURNING j.ticket_id
      )
      UPDATE tickets AS t
      SET
        status = 'failed',
        category = NULL,
        priority = NULL,
        summary = NULL,
        failure_code = 'WORKER_LOST',
        classifier_version = NULL,
        prompt_version = NULL,
        classified_at = NULL,
        updated_at = NOW()
      FROM dead
      WHERE t.id = dead.ticket_id
        AND t.status = 'pending'
      RETURNING t.id
      `,
      [maxAttempts],
    );

    return {
      requeued: requeued.rowCount ?? 0,
      failed: failedJobs.rowCount ?? 0,
    };
  }

  /**
   * Claim due jobs with SKIP LOCKED.
   * Increments attempt_count and assigns a fresh lease_token per claim.
   */
  async claimDueJobs(input: {
    workerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<ClassificationJob[]> {
    if (input.limit <= 0) {
      return [];
    }

    const now = this.clock.now();

    const result = await query<JobRow>(
      this.db,
      `
      WITH candidates AS (
        SELECT id
        FROM classification_jobs
        WHERE state = 'pending'
          AND next_available_at <= $1
        ORDER BY next_available_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      UPDATE classification_jobs AS j
      SET
        state = 'leased',
        lease_owner = $3,
        lease_expires_at = NOW() + ($4::text || ' milliseconds')::interval,
        lease_token = gen_random_uuid(),
        attempt_count = j.attempt_count + 1,
        updated_at = NOW()
      FROM candidates
      WHERE j.id = candidates.id
      RETURNING j.*
      `,
      [now, input.limit, input.workerId, input.leaseMs],
    );

    return result.rows.map(mapJobRow);
  }

  async findById(id: number): Promise<ClassificationJob | null> {
    const result = await query<JobRow>(this.db, `SELECT * FROM classification_jobs WHERE id = $1`, [
      id,
    ]);
    const row = result.rows[0];
    return row ? mapJobRow(row) : null;
  }

  /** Finalize success only with a matching non-expired lease token. */
  async completeIfOwned(input: { jobId: number; leaseToken: string }): Promise<boolean> {
    const result = await query(
      this.db,
      `
      UPDATE classification_jobs
      SET
        state = 'completed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        lease_token = NULL,
        last_error_code = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND state = 'leased'
        AND lease_token = $2
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > NOW()
      `,
      [input.jobId, input.leaseToken],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Schedule retry without changing attempt_count (already incremented on claim).
   */
  async scheduleRetryIfOwned(input: {
    jobId: number;
    leaseToken: string;
    nextAvailableAt: Date;
    errorCode: FailureCode;
  }): Promise<boolean> {
    const result = await query(
      this.db,
      `
      UPDATE classification_jobs
      SET
        state = 'pending',
        next_available_at = $3,
        lease_owner = NULL,
        lease_expires_at = NULL,
        lease_token = NULL,
        last_error_code = $4,
        updated_at = NOW()
      WHERE id = $1
        AND state = 'leased'
        AND lease_token = $2
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > NOW()
      `,
      [input.jobId, input.leaseToken, input.nextAvailableAt, input.errorCode],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markDeadIfOwned(input: {
    jobId: number;
    leaseToken: string;
    errorCode: FailureCode;
  }): Promise<boolean> {
    const result = await query(
      this.db,
      `
      UPDATE classification_jobs
      SET
        state = 'dead',
        lease_owner = NULL,
        lease_expires_at = NULL,
        lease_token = NULL,
        last_error_code = $3,
        updated_at = NOW()
      WHERE id = $1
        AND state = 'leased'
        AND lease_token = $2
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > NOW()
      `,
      [input.jobId, input.leaseToken, input.errorCode],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Cooperative shutdown release: fence by lease token, restore the claim attempt,
   * and leave any previous last_error_code unchanged.
   */
  async releaseLeaseIfOwned(input: {
    jobId: number;
    leaseToken: string;
    restoreAttempt: boolean;
  }): Promise<boolean> {
    const result = await query(
      this.db,
      `
      UPDATE classification_jobs
      SET
        state = 'pending',
        attempt_count = CASE
          WHEN $3 THEN GREATEST(attempt_count - 1, 0)
          ELSE attempt_count
        END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        lease_token = NULL,
        next_available_at = LEAST(next_available_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
        AND state = 'leased'
        AND lease_token = $2
      `,
      [input.jobId, input.leaseToken, input.restoreAttempt],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
