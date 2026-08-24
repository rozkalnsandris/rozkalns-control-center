-- Rozkalns Control Phase 3 source-only Merge audit/idempotency schema.
-- This migration file does not apply itself to local or production D1.
-- Access JWTs, GitHub tokens, private keys, secrets and request payloads are intentionally excluded.

CREATE TABLE merge_decisions (
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
  merge_method TEXT NOT NULL CHECK (merge_method IN ('merge', 'squash', 'rebase')),
  expected_head_sha TEXT NOT NULL
    CHECK (length(expected_head_sha) = 40 AND expected_head_sha NOT GLOB '*[^0-9a-f]*'),
  expected_main_sha TEXT NOT NULL
    CHECK (length(expected_main_sha) = 40 AND expected_main_sha NOT GLOB '*[^0-9a-f]*'),
  requested_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  outcome_code TEXT,
  mutation_attempted INTEGER CHECK (mutation_attempted IS NULL OR mutation_attempted IN (0, 1)),
  observed_head_sha TEXT
    CHECK (observed_head_sha IS NULL OR (length(observed_head_sha) = 40 AND observed_head_sha NOT GLOB '*[^0-9a-f]*')),
  observed_main_sha TEXT
    CHECK (observed_main_sha IS NULL OR (length(observed_main_sha) = 40 AND observed_main_sha NOT GLOB '*[^0-9a-f]*')),
  observed_at TEXT,
  merge_sha TEXT
    CHECK (merge_sha IS NULL OR (length(merge_sha) = 40 AND merge_sha NOT GLOB '*[^0-9a-f]*')),
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
      AND mutation_attempted IS NULL
      AND observed_head_sha IS NULL
      AND observed_main_sha IS NULL
      AND observed_at IS NULL
      AND merge_sha IS NULL
      AND completed_at IS NULL
    )
  ),
  CHECK (
    state <> 'SUCCEEDED' OR (
      outcome_code IS NULL
      AND mutation_attempted = 1
      AND observed_head_sha IS NOT NULL
      AND observed_main_sha IS NOT NULL
      AND observed_at IS NOT NULL
      AND merge_sha IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  CHECK (
    state <> 'FAILED' OR (
      outcome_code IS NOT NULL
      AND mutation_attempted IN (0, 1)
      AND observed_head_sha IS NULL
      AND observed_main_sha IS NULL
      AND observed_at IS NULL
      AND merge_sha IS NULL
      AND completed_at IS NOT NULL
    )
  ),
  CHECK (
    state <> 'UNKNOWN' OR (
      outcome_code = 'WRITE_OUTCOME_UNKNOWN'
      AND mutation_attempted = 1
      AND observed_head_sha IS NULL
      AND observed_main_sha IS NULL
      AND observed_at IS NULL
      AND merge_sha IS NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_merge_decisions_state_requested_at
  ON merge_decisions (state, requested_at);

CREATE INDEX idx_merge_decisions_repository_pull_requested_at
  ON merge_decisions (repository, pull_number, requested_at);
