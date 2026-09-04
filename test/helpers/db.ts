import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { createPool } from '../../src/database/pool.js';

const execFileAsync = promisify(execFile);

/**
 * Integration tests require an explicit TEST_DATABASE_URL whose database name
 * ends with `_test`. Never fall back to DATABASE_URL.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required for integration tests. ' +
        'Create database loura_test and set TEST_DATABASE_URL=postgres://loura:loura@localhost:5434/loura_test',
    );
  }

  let databaseName: string;
  try {
    databaseName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL');
  }

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against database "${databaseName}". ` +
        'TEST_DATABASE_URL must point at a database whose name ends with _test.',
    );
  }

  return url;
}

export async function migrateTestDatabase(): Promise<void> {
  const databaseUrl = requireTestDatabaseUrl();
  await execFileAsync(
    'npx',
    [
      'node-pg-migrate',
      'up',
      '--database-url-var',
      'DATABASE_URL',
      '--migrations-dir',
      'migrations',
    ],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      cwd: process.cwd(),
    },
  );
}

export async function truncateAll(pool: Pool): Promise<void> {
  requireTestDatabaseUrl();
  await pool.query('TRUNCATE classification_jobs, tickets RESTART IDENTITY CASCADE');
}

export async function createTestPool(): Promise<Pool> {
  return createPool(requireTestDatabaseUrl());
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(options.message ?? 'waitUntil timed out');
}

/** Force-expire a lease for restart/reclaim tests (uses wall-clock NOW() comparisons). */
export async function expireLease(pool: Pool, jobId: number): Promise<void> {
  await pool.query(
    `
    UPDATE classification_jobs
    SET lease_expires_at = NOW() - interval '1 second', updated_at = NOW()
    WHERE id = $1 AND state = 'leased'
    `,
    [jobId],
  );
}
