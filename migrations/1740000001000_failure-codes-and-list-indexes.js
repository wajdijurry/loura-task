/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export async function up(pgm) {
  pgm.sql(`
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

CREATE INDEX IF NOT EXISTS tickets_created_id_idx
  ON tickets (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tickets_priority_list_idx
  ON tickets (priority, created_at DESC, id DESC);
`);
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS tickets_priority_list_idx;
DROP INDEX IF EXISTS tickets_created_id_idx;
ALTER TABLE classification_jobs DROP CONSTRAINT IF EXISTS jobs_last_error_code_allowed;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_failure_code_allowed;
`);
}
