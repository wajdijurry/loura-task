/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export async function up(pgm) {
  pgm.sql(`
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'classified', 'failed')),
  category TEXT
    CHECK (category IS NULL OR category IN ('billing', 'technical', 'account', 'other')),
  priority TEXT
    CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high')),
  summary TEXT,
  failure_code TEXT
    CHECK (failure_code IS NULL OR failure_code IN ('MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'INVALID_MODEL_OUTPUT')),
  classifier_version TEXT,
  prompt_version TEXT,
  classified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tickets_pending_state CHECK (
    status <> 'pending'
    OR (
      category IS NULL
      AND priority IS NULL
      AND summary IS NULL
      AND failure_code IS NULL
      AND classifier_version IS NULL
      AND prompt_version IS NULL
      AND classified_at IS NULL
    )
  ),
  CONSTRAINT tickets_classified_state CHECK (
    status <> 'classified'
    OR (
      category IS NOT NULL
      AND priority IS NOT NULL
      AND summary IS NOT NULL
      AND failure_code IS NULL
      AND classifier_version IS NOT NULL
      AND prompt_version IS NOT NULL
      AND classified_at IS NOT NULL
    )
  ),
  CONSTRAINT tickets_failed_state CHECK (
    status <> 'failed'
    OR (
      category IS NULL
      AND priority IS NULL
      AND summary IS NULL
      AND failure_code IS NOT NULL
      AND classifier_version IS NULL
      AND prompt_version IS NULL
      AND classified_at IS NULL
    )
  )
);

CREATE INDEX tickets_list_idx
  ON tickets (category, priority, created_at DESC, id DESC);

CREATE INDEX tickets_priority_list_idx
  ON tickets (priority, created_at DESC, id DESC);

CREATE INDEX tickets_created_id_idx
  ON tickets (created_at DESC, id DESC);

CREATE INDEX tickets_status_idx ON tickets (status);

CREATE TABLE classification_jobs (
  id BIGSERIAL PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets (id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'completed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT
    CHECK (last_error_code IS NULL OR last_error_code IN ('MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'INVALID_MODEL_OUTPUT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT jobs_lease_consistency CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX classification_jobs_claim_idx
  ON classification_jobs (next_available_at, id)
  WHERE state IN ('pending', 'leased');

CREATE INDEX classification_jobs_lease_expiry_idx
  ON classification_jobs (lease_expires_at)
  WHERE state = 'leased';
`);
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export async function down(pgm) {
  pgm.sql(`
DROP TABLE IF EXISTS classification_jobs;
DROP TABLE IF EXISTS tickets;
`);
}
