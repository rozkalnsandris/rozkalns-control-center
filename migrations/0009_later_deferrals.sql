-- Rozkalns Control Phase 3 source-only Later deferral persistence schema.
-- This migration file does not apply itself to local or production D1.
-- Access JWTs, GitHub tokens, private keys, secrets and request payloads are intentionally excluded.

CREATE TABLE later_deferrals (
  decision_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(decision_id) BETWEEN 1 AND 256),
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  project_id TEXT NOT NULL
    CHECK (length(project_id) BETWEEN 1 AND 256),
  issue_number INTEGER
    CHECK (issue_number IS NULL OR issue_number > 0),
  pr_number INTEGER
    CHECK (pr_number IS NULL OR pr_number > 0),
  state_fingerprint TEXT NOT NULL
    CHECK (
      length(state_fingerprint) = 25
      AND substr(state_fingerprint, 1, 9) = 'later-v1-'
      AND substr(state_fingerprint, 10) NOT GLOB '*[^0-9a-f]*'
    ),
  deferred_at TEXT NOT NULL,
  actor_subject TEXT NOT NULL
    CHECK (length(actor_subject) BETWEEN 1 AND 512),
  actor_email TEXT
    CHECK (actor_email IS NULL OR length(actor_email) BETWEEN 1 AND 512)
);

CREATE INDEX idx_later_deferrals_project_deferred_at
  ON later_deferrals (project_id, deferred_at);
