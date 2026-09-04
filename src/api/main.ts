import 'dotenv/config';
import { loadConfig } from '../config/env.js';
import { createPool } from '../database/pool.js';
import { systemClock } from '../shared/clock.js';
import { createLogger } from '../shared/logger.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    name: 'api',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });

  const pool = createPool(config.DATABASE_URL);
  const app = await buildApp({ pool, clock: systemClock, logger });

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'api shutting down');
    try {
      await app.close();
      await pool.end();
      logger.info('api stopped');
      process.exit(0);
    } catch (error) {
      logger.error(
        { err: { name: error instanceof Error ? error.name : 'unknown' } },
        'api shutdown failed',
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT }, 'api listening');
}

main().catch((error: unknown) => {
  console.error('Fatal API startup error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
