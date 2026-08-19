-- Rozkalns Control Phase 4 source-only durable notification transition registry.
-- This migration file does not apply itself to local or production D1.
-- Provider credentials, delivery tokens, privileged action tokens and private evidence are intentionally excluded.

CREATE TABLE notification_transitions (
  transition_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(transition_id) BETWEEN 32 AND 80),
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  signal TEXT NOT NULL
    CHECK (signal IN ('NEEDS_ANDRIS', 'CI_FAILED')),
  decision_id TEXT NOT NULL
    CHECK (length(decision_id) BETWEEN 1 AND 512),
  project_id TEXT NOT NULL
    CHECK (length(project_id) BETWEEN 1 AND 200),
  reference TEXT NOT NULL
    CHECK (length(reference) BETWEEN 1 AND 80),
  title TEXT NOT NULL
    CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL
    CHECK (length(body) BETWEEN 1 AND 280),
  deep_link_path TEXT NOT NULL
    CHECK (length(deep_link_path) BETWEEN 12 AND 1200 AND deep_link_path LIKE '/#decision-%'),
  claimed_at TEXT NOT NULL
);
