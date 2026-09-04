import 'dotenv/config';
import { FakeModelClient } from '../classification/fake-model-client.js';
import { ClassificationService } from '../classification/classification-service.js';
import { loadConfig } from '../config/env.js';
import { createPool } from '../database/pool.js';
import { ClassificationWorker } from '../jobs/classification-worker.js';
import { systemClock } from '../shared/clock.js';
import { createLogger } from '../shared/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    name: 'worker',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });

  const pool = createPool(config.DATABASE_URL);
  const model = new FakeModelClient(config.FAKE_MODEL_LATENCY_MS);
  const classification = new ClassificationService(model, config.MODEL_TIMEOUT_MS);

  const worker = new ClassificationWorker({
    pool,
    classification,
    clock: systemClock,
    logger,
    options: {
      workerId: config.workerId,
      concurrency: config.WORKER_CONCURRENCY,
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      leaseMs: config.JOB_LEASE_MS,
      maxAttempts: config.MAX_CLASSIFICATION_ATTEMPTS,
      shutdownGraceMs: config.WORKER_SHUTDOWN_GRACE_MS,
      classifierVersion: config.CLASSIFIER_VERSION,
      promptVersion: config.PROMPT_VERSION,
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal');
    try {
      await worker.stop();
      await pool.end();
      process.exit(0);
    } catch (error) {
      logger.error(
        { err: { name: error instanceof Error ? error.name : 'unknown' } },
        'worker shutdown failed',
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await worker.start();
}

main().catch((error: unknown) => {
  console.error('Fatal worker startup error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
