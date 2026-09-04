import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { ClassificationService } from '../classification/classification-service.js';
import { withTransaction } from '../database/pool.js';
import { JobRepository } from '../jobs/job-repository.js';
import { computeBackoffMs } from '../shared/backoff.js';
import type { Clock } from '../shared/clock.js';
import type { Classification, ClassificationJob, FailureCode } from '../shared/types.js';
import { TicketRepository } from '../tickets/ticket-repository.js';

export interface WorkerOptions {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  maxAttempts: number;
  shutdownGraceMs: number;
  classifierVersion: string;
  promptVersion: string;
  random?: () => number;
}

export interface WorkerDeps {
  pool: Pool;
  classification: ClassificationService;
  clock: Clock;
  logger: Logger;
  options: WorkerOptions;
}

type InFlight = {
  jobId: number;
  ticketId: string;
  leaseToken: string;
  abort: AbortController;
  done: Promise<void>;
};

/**
 * Durable async worker with SKIP LOCKED claims, lease-token fencing, and
 * claim-time attempt accounting.
 *
 * External model calls remain at-least-once after crashes; DB transitions are
 * fenced so a stale claim cannot overwrite a newer lease.
 */
export class ClassificationWorker {
  private running = false;
  private stopping = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<number, InFlight>();
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private claimChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WorkerDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    this.deps.logger.info({ workerId: this.deps.options.workerId }, 'worker started');
    this.loopPromise = this.pollLoop();
  }

  async processBatch(): Promise<number> {
    return this.withClaimLock(async () => {
      await this.reclaimExpired();
      if (this.stopping) {
        return 0;
      }

      const slots = this.deps.options.concurrency - this.inFlight.size;
      if (slots <= 0) {
        return 0;
      }

      const jobs = await this.claimJobs(slots);

      if (this.stopping) {
        for (const job of jobs) {
          if (job.leaseToken) {
            await this.releaseJobQuietly(job.id, job.leaseToken, true);
          }
        }
        return 0;
      }

      for (const job of jobs) {
        this.track(job);
      }
      return jobs.length;
    });
  }

  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0) {
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for worker idle');
      }
      await Promise.race([...this.inFlight.values()].map((f) => f.done));
    }
  }

  async stop(): Promise<void> {
    if (this.stopping && !this.running && this.inFlight.size === 0) {
      return;
    }

    this.stopping = true;
    this.deps.logger.info({ workerId: this.deps.options.workerId }, 'worker shutting down');

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.wake?.();

    // Wait for any claim/batch currently holding the mutex.
    await this.withClaimLock(async () => undefined);

    const grace = this.deps.options.shutdownGraceMs;
    const deadline = Date.now() + grace;

    while (this.inFlight.size > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await Promise.race([
        Promise.allSettled([...this.inFlight.values()].map((f) => f.done)),
        sleep(Math.min(50, Math.max(0, remaining))),
      ]);
    }

    if (this.inFlight.size > 0) {
      this.deps.logger.warn(
        { remaining: this.inFlight.size },
        'shutdown grace expired; aborting in-flight jobs',
      );
      const snapshot = [...this.inFlight.values()];
      for (const flight of snapshot) {
        flight.abort.abort();
      }
      // Classification wrapper settles on parent cancel even if the model ignores abort.
      await Promise.race([
        Promise.allSettled(snapshot.map((f) => f.done)),
        sleep(Math.max(500, this.deps.options.shutdownGraceMs > 0 ? 500 : 0)),
      ]);

      // Release individually by fencing token — never bulk by workerId alone.
      for (const flight of snapshot) {
        await this.releaseJobQuietly(flight.jobId, flight.leaseToken, true);
      }
    }

    // Ensure tracked wrappers have left the map.
    await Promise.allSettled([...this.inFlight.values()].map((f) => f.done));

    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    this.deps.logger.info({ workerId: this.deps.options.workerId }, 'worker stopped');
  }

  private withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.claimChain.then(fn, fn);
    this.claimChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async pollLoop(): Promise<void> {
    while (this.running && !this.stopping) {
      try {
        await this.processBatch();
      } catch (error) {
        this.deps.logger.error({ err: sanitizeError(error) }, 'worker poll batch failed');
      }

      if (this.stopping) {
        break;
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.pollTimer = setTimeout(resolve, this.deps.options.pollIntervalMs);
      });
      this.wake = null;
      this.pollTimer = null;
    }
  }

  private async reclaimExpired(): Promise<void> {
    const result = await withTransaction(this.deps.pool, async (client) => {
      const jobs = new JobRepository(client, this.deps.clock);
      return jobs.reclaimExpiredLeases(this.deps.options.maxAttempts);
    });
    if (result.requeued > 0 || result.failed > 0) {
      this.deps.logger.info(result, 'reclaimed expired job leases');
    }
  }

  private async claimJobs(limit: number): Promise<ClassificationJob[]> {
    return withTransaction(this.deps.pool, async (client) => {
      const jobs = new JobRepository(client, this.deps.clock);
      return jobs.claimDueJobs({
        workerId: this.deps.options.workerId,
        limit,
        leaseMs: this.deps.options.leaseMs,
      });
    });
  }

  private track(job: ClassificationJob): void {
    if (!job.leaseToken) {
      this.deps.logger.error({ jobId: job.id }, 'claimed job missing lease token');
      return;
    }
    const abort = new AbortController();
    const leaseToken = job.leaseToken;
    const done = this.executeJob(job, abort.signal)
      .catch((error: unknown) => {
        this.deps.logger.error(
          {
            err: sanitizeError(error),
            jobId: job.id,
            ticketId: job.ticketId,
          },
          'unhandled job execution failure',
        );
      })
      .finally(() => {
        this.inFlight.delete(job.id);
      });
    this.inFlight.set(job.id, {
      jobId: job.id,
      ticketId: job.ticketId,
      leaseToken,
      abort,
      done,
    });
  }

  private async executeJob(job: ClassificationJob, signal: AbortSignal): Promise<void> {
    const leaseToken = job.leaseToken;
    if (!leaseToken) {
      return;
    }

    const log = this.deps.logger.child({
      jobId: job.id,
      ticketId: job.ticketId,
      workerId: this.deps.options.workerId,
    });

    try {
      // Never invoke the model when the claim already exhausted the attempt budget.
      if (job.attemptCount > this.deps.options.maxAttempts) {
        await this.finalizeFailure(job, leaseToken, 'WORKER_LOST', true);
        return;
      }

      const ticketRepo = new TicketRepository(this.deps.pool);
      const ticket = await ticketRepo.findById(job.ticketId);
      if (!ticket) {
        log.error('ticket missing for job; marking dead');
        await this.finalizeFailure(job, leaseToken, 'MODEL_UNAVAILABLE', true);
        return;
      }

      if (ticket.status !== 'pending') {
        await withTransaction(this.deps.pool, async (client) => {
          const jobs = new JobRepository(client, this.deps.clock);
          await jobs.completeIfOwned({ jobId: job.id, leaseToken });
        });
        return;
      }

      if (this.stopping || signal.aborted) {
        await this.releaseJobQuietly(job.id, leaseToken, true);
        return;
      }

      const result = await this.deps.classification.classify(
        { subject: ticket.subject, body: ticket.body },
        signal,
      );

      if (!result.ok && result.kind === 'cancelled') {
        await this.releaseJobQuietly(job.id, leaseToken, true);
        log.info('released job after cooperative cancellation');
        return;
      }

      if (result.ok) {
        const committed = await this.finalizeSuccess(job, leaseToken, result.classification);
        if (!committed) {
          log.info('discarded stale classification; lease token no longer owned');
        } else {
          log.info({ category: result.classification.category }, 'ticket classified');
        }
        return;
      }

      const failureCode = result.code;
      const terminal = job.attemptCount >= this.deps.options.maxAttempts;
      const committed = await this.finalizeFailure(job, leaseToken, failureCode, terminal);
      if (!committed) {
        log.info('discarded stale failure; lease token no longer owned');
      } else if (terminal) {
        log.warn({ failureCode, attemptCount: job.attemptCount }, 'ticket failed permanently');
      } else {
        log.warn({ failureCode, attemptCount: job.attemptCount }, 'classification retry scheduled');
      }
    } catch (error) {
      log.error({ err: sanitizeError(error) }, 'unexpected job execution error');
      const terminal = job.attemptCount >= this.deps.options.maxAttempts;
      await this.finalizeFailure(job, leaseToken, 'MODEL_UNAVAILABLE', terminal);
    }
  }

  private async finalizeSuccess(
    job: ClassificationJob,
    leaseToken: string,
    classification: Classification,
  ): Promise<boolean> {
    return withTransaction(this.deps.pool, async (client) => {
      const jobs = new JobRepository(client, this.deps.clock);
      const tickets = new TicketRepository(client);

      const stillOwned = await jobs.completeIfOwned({ jobId: job.id, leaseToken });
      if (!stillOwned) {
        return false;
      }

      const updated = await tickets.markClassified({
        ticketId: job.ticketId,
        classification,
        classifierVersion: this.deps.options.classifierVersion,
        promptVersion: this.deps.options.promptVersion,
        classifiedAt: this.deps.clock.now(),
      });
      if (!updated) {
        throw new Error('Ticket was not pending when finalizing classification');
      }
      return true;
    });
  }

  private async finalizeFailure(
    job: ClassificationJob,
    leaseToken: string,
    errorCode: FailureCode,
    terminal: boolean,
  ): Promise<boolean> {
    const random = this.deps.options.random ?? Math.random;

    return withTransaction(this.deps.pool, async (client) => {
      const jobs = new JobRepository(client, this.deps.clock);
      const tickets = new TicketRepository(client);

      if (terminal) {
        const stillOwned = await jobs.markDeadIfOwned({
          jobId: job.id,
          leaseToken,
          errorCode,
        });
        if (!stillOwned) {
          return false;
        }
        const updated = await tickets.markFailed({
          ticketId: job.ticketId,
          failureCode: errorCode,
        });
        if (!updated) {
          throw new Error('Ticket was not pending when marking failed');
        }
        return true;
      }

      const delayMs = computeBackoffMs(job.attemptCount, random);
      const nextAvailableAt = new Date(this.deps.clock.now().getTime() + delayMs);
      return jobs.scheduleRetryIfOwned({
        jobId: job.id,
        leaseToken,
        nextAvailableAt,
        errorCode,
      });
    });
  }

  private async releaseJobQuietly(
    jobId: number,
    leaseToken: string,
    restoreAttempt: boolean,
  ): Promise<boolean> {
    try {
      const jobs = new JobRepository(this.deps.pool, this.deps.clock);
      return await jobs.releaseLeaseIfOwned({ jobId, leaseToken, restoreAttempt });
    } catch (error) {
      this.deps.logger.error(
        { err: sanitizeError(error), jobId },
        'failed to release job lease; relying on lease expiration',
      );
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.name };
  }
  return { name: 'UnknownError', message: 'unknown' };
}
