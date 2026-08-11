-- Rozkalns Control Phase 2 source-only durability schema.
-- No D1 binding/resource is created by this migration file alone.
-- Secrets, credentials, webhook payload bodies and GitHub tokens are intentionally excluded.

CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  repository TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  message_version INTEGER NOT NULL DEFAULT 1 CHECK (message_version = 1),
  state TEXT NOT NULL CHECK (
    state IN (
      'RECEIVED',
      'ENQUEUED',
      'PROCESSING',
      'RETRY_PENDING',
      'SUCCEEDED',
      'DEAD_LETTERED'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at TEXT NOT NULL,
  enqueued_at TEXT,
  processing_started_at TEXT,
  last_attempt_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  dead_lettered_at TEXT,
  last_error_code TEXT,
  CHECK (state <> 'SUCCEEDED' OR completed_at IS NOT NULL),
  CHECK (state <> 'DEAD_LETTERED' OR dead_lettered_at IS NOT NULL),
  CHECK (state NOT IN ('RETRY_PENDING', 'DEAD_LETTERED') OR last_error_code IS NOT NULL)
);

CREATE INDEX idx_webhook_deliveries_state_updated_at
  ON webhook_deliveries (state, updated_at);

CREATE INDEX idx_webhook_deliveries_repository_updated_at
  ON webhook_deliveries (repository, updated_at);
