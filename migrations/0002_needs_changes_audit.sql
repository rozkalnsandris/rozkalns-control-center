-- Rozkalns Control Phase 3 source-only Needs changes audit/idempotency schema.
-- This migration file does not apply itself to local or production D1.
-- Review bodies, Access JWTs, GitHub tokens, private keys and secrets are intentionally excluded.

CREATE TABLE needs_changes_decisions (
  request_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(request_id) BETWEEN 16 AND 128),
  fingerprint TEXT NOT NULL
    CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  actor_subject TEXT NOT NULL
    CHECK (length(actor_subject) BETWEEN 1 AND 512),
  actor_email TEXT
    CHECK (actor_email IS NULL OR length(actor_email) BETWEEN 1 AND 512),
  repository TEXT NOT NULL,
  project_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  pull_number INTEGER NOT NULL CHECK (pull_number > 0),
  expected_head_sha TEXT NOT NULL
    CHECK (length(expected_head_sha) = 40 AND expected_head_sha NOT GLOB '*[^0-9a-f]*'),
  expected_main_sha TEXT NOT NULL
    CHECK (length(expected_main_sha) = 40 AND expected_main_sha NOT GLOB '*[^0-9a-f]*'),
  requested_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  outcome_code TEXT,
  observed_head_sha TEXT
    CHECK (observed_head_sha IS NULL OR (length(observed_head_sha) = 40 AND observed_head_sha NOT GLOB '*[^0-9a-f]*')),
  observed_main_sha TEXT
    CHECK (observed_main_sha IS NULL OR (length(observed_main_sha) = 40 AND observed_main_sha NOT GLOB '*[^0-9a-f]*')),
  observed_at TEXT,
  review_id TEXT,
  review_url TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  CHECK (
    state <> 'FAILED' OR outcome_code IN (
      'INVALID_REQUEST',
      'POLICY_EVIDENCE_INCOMPLETE',
      'AUTHORIZATION_STALE_HEAD',
      'AUTHORIZATION_STALE_BASE',
      'DECISION_NOT_READY',
      'RECONCILIATION_FAILED',
      'WRITE_REJECTED'
    )
  ),
  CHECK (state <> 'UNKNOWN' OR outcome_code = 'WRITE_OUTCOME_UNKNOWN'),
  CHECK (
    state <> 'IN_PROGRESS' OR (
      outcome_code IS NULL
      AND observed_head_sha IS NULL
      AND observed_main_sha IS NULL
      AND observed_at IS NULL
      AND review_id IS NULL
      AND review_url IS NULL
      AND submitted_at IS NULL
      AND completed_at IS NULL
    )
  ),
  CHECK (
    state <> 'SUCCEEDED' OR (
      outcome_code IS NULL
      AND observed_head_sha IS NOT NULL
      AND observed_main_sha IS NOT NULL
      AND observed_at IS NOT NULL
      AND review_id IS NOT NULL
      AND review_url IS NOT NULL
      AND submitted_at IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  CHECK (
    state NOT IN ('FAILED', 'UNKNOWN') OR (
      outcome_code IS NOT NULL
      AND observed_head_sha IS NULL
      AND observed_main_sha IS NULL
      AND observed_at IS NULL
      AND review_id IS NULL
      AND review_url IS NULL
      AND submitted_at IS NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_needs_changes_decisions_state_requested_at
  ON needs_changes_decisions (state, requested_at);

CREATE INDEX idx_needs_changes_decisions_repository_pull_requested_at
  ON needs_changes_decisions (repository, pull_number, requested_at);
