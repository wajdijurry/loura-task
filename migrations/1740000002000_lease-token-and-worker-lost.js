/**
 * Adds lease fencing tokens and expands allowed failure codes with WORKER_LOST.
 * Also refreshes list indexes required by the list API shapes.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export async function up(pgm) {
  pgm.sql(`
-- Refresh failure-code constraints to include WORKER_LOST (crash/reclaim exhaustion).
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_failure_code_allowed;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_failure_code_check;
ALTER TABLE classification_jobs DROP CONSTRAINT IF EXISTS jobs_last_error_code_allowed;
ALTER TABLE classification_jobs DROP CONSTRAINT IF EXISTS classification_jobs_last_error_code_check;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_failure_code_allowed
  CHECK (
    failure_code IS NULL
    OR failure_code IN (
      'MODEL_TIMEOUT',
      'MODEL_UNAVAILABLE',
      'INVALID_MODEL_OUTPUT',
      'WORKER_LOST'
    )
  );

ALTER TABLE classification_jobs
  ADD CONSTRAINT jobs_last_error_code_allowed
  CHECK (
    last_error_code IS NULL
    OR last_error_code IN (
      'MODEL_TIMEOUT',
      'MODEL_UNAVAILABLE',
      'INVALID_MODEL_OUTPUT',
      'WORKER_LOST'
    )
  );

-- Per-claim fencing token: stale workers cannot finalize after reclaim.
ALTER TABLE classification_jobs
  ADD COLUMN IF NOT EXISTS lease_token UUID;

ALTER TABLE classification_jobs DROP CONSTRAINT IF EXISTS jobs_lease_consistency;
ALTER TABLE classification_jobs
  ADD CONSTRAINT jobs_lease_consistency CHECK (
    (
      state = 'leased'
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_token IS NOT NULL
    )
    OR (
      state <> 'leased'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND lease_token IS NULL
    )
  );

-- Minimal justified list indexes for required query shapes.
CREATE INDEX IF NOT EXISTS tickets_created_id_idx
  ON tickets (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tickets_list_idx
  ON tickets (category, priority, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tickets_priority_list_idx
  ON tickets (priority, created_at DESC, id DESC);
`);
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export async function down(pgm) {
  pgm.sql(`
ALTER TABLE classification_jobs DROP CONSTRAINT IF EXISTS jobs_lease_consistency;
ALTER TABLE classification_jobs DROP COLUMN IF EXISTS lease_token;
ALTER TABLE classification_jobs
  ADD CONSTRAINT jobs_lease_consistency CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  );

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_failure_code_allowed;
ALTER TABLE classification_jobs DROP CONSTRAINT IF EXISTS jobs_last_error_code_allowed;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_failure_code_allowed
  CHECK (
    failure_code IS NULL
    OR failure_code IN ('MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'INVALID_MODEL_OUTPUT')
  );

ALTER TABLE classification_jobs
  ADD CONSTRAINT jobs_last_error_code_allowed
  CHECK (
    last_error_code IS NULL
    OR last_error_code IN ('MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'INVALID_MODEL_OUTPUT')
  );
`);
}
