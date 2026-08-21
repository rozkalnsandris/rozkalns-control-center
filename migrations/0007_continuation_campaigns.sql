-- Rozkalns Control Phase 4 source-only deterministic campaign/task durability.
-- This migration never applies itself to local or production D1.
-- Credentials, notification destinations, provider payloads and approvals are excluded.

CREATE TABLE continuation_campaigns (
  campaign_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(campaign_id) BETWEEN 1 AND 128
      AND campaign_id GLOB '[A-Za-z0-9]*'
      AND campaign_id NOT GLOB '*[^A-Za-z0-9:_-]*'
    ),
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  project_id TEXT NOT NULL
    CHECK (
      length(project_id) BETWEEN 1 AND 128
      AND project_id GLOB '[a-z0-9]*'
      AND project_id NOT GLOB '*[^a-z0-9:_-]*'
    ),
  repository TEXT NOT NULL
    CHECK (
      length(repository) BETWEEN 3 AND 255
      AND repository = lower(repository)
      AND repository GLOB '[a-z0-9]*/[a-z0-9]*'
      AND repository NOT GLOB '*[^a-z0-9._/-]*'
      AND length(repository) - length(replace(repository, '/', '')) = 1
    ),
  scope TEXT NOT NULL
    CHECK (
      length(scope) BETWEEN 1 AND 128
      AND length(trim(scope)) > 0
      AND scope NOT GLOB '*[^A-Za-z0-9:_./ -]*'
    ),
  mode TEXT NOT NULL
    CHECK (mode = 'CONTINUE_ISSUES'),
  continue_enabled INTEGER NOT NULL
    CHECK (continue_enabled IN (0, 1)),
  paused INTEGER NOT NULL
    CHECK (paused IN (0, 1)),
  expected_main_sha TEXT NOT NULL
    CHECK (
      length(expected_main_sha) = 40
      AND expected_main_sha GLOB '[0-9a-f]*'
      AND expected_main_sha NOT GLOB '*[^0-9a-f]*'
    ),
  current_task_id TEXT
    CHECK (
      current_task_id IS NULL OR (
        length(current_task_id) BETWEEN 1 AND 128
        AND current_task_id GLOB '[A-Za-z0-9]*'
        AND current_task_id NOT GLOB '*[^A-Za-z0-9:_-]*'
      )
    ),
  current_task_state TEXT
    CHECK (
      current_task_state IS NULL OR current_task_state IN (
        'DISCOVERED', 'READY', 'WORKING', 'WAITING', 'PR_DRAFT',
        'WAIT_CI', 'REVIEW', 'NEEDS_ANDRIS', 'MERGE_READY', 'MERGED',
        'DEPLOY_DECISION', 'PRODUCTION_VERIFY', 'DONE', 'PAUSED',
        'BLOCKED', 'CI_FAILED', 'CANCELLED'
      )
    ),
  next_task_id TEXT
    CHECK (
      next_task_id IS NULL OR (
        length(next_task_id) BETWEEN 1 AND 128
        AND next_task_id GLOB '[A-Za-z0-9]*'
        AND next_task_id NOT GLOB '*[^A-Za-z0-9:_-]*'
      )
    ),
  human_gate TEXT
    CHECK (
      human_gate IS NULL OR
      human_gate IN ('MERGE', 'DEPLOY', 'NEEDS_CHANGES', 'PRODUCTION_MUTATION')
    ),
  observed_at TEXT NOT NULL
    CHECK (
      length(observed_at) = 24
      AND observed_at GLOB '????-??-??T??:??:??.???Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) = observed_at
    ),
  updated_at TEXT NOT NULL
    CHECK (
      length(updated_at) = 24
      AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    ),
  CHECK ((current_task_id IS NULL) = (current_task_state IS NULL)),
  CHECK (
    next_task_id IS NULL OR (
      continue_enabled = 1
      AND paused = 0
      AND human_gate IS NULL
      AND (current_task_state IS NULL OR current_task_state = 'DONE')
      AND (current_task_id IS NULL OR next_task_id <> current_task_id)
    )
  ),
  CHECK (updated_at >= observed_at),
  UNIQUE (campaign_id, project_id, repository)
);

CREATE TABLE continuation_tasks (
  campaign_id TEXT NOT NULL,
  task_id TEXT NOT NULL
    CHECK (
      length(task_id) BETWEEN 1 AND 128
      AND task_id GLOB '[A-Za-z0-9]*'
      AND task_id NOT GLOB '*[^A-Za-z0-9:_-]*'
    ),
  project_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  issue_number INTEGER NOT NULL
    CHECK (issue_number BETWEEN 1 AND 9007199254740991),
  task_state TEXT NOT NULL
    CHECK (
      task_state IN (
        'DISCOVERED', 'READY', 'WORKING', 'WAITING', 'PR_DRAFT',
        'WAIT_CI', 'REVIEW', 'NEEDS_ANDRIS', 'MERGE_READY', 'MERGED',
        'DEPLOY_DECISION', 'PRODUCTION_VERIFY', 'DONE', 'PAUSED',
        'BLOCKED', 'CI_FAILED', 'CANCELLED'
      )
    ),
  active_pull_request_number INTEGER
    CHECK (
      active_pull_request_number IS NULL OR
      active_pull_request_number BETWEEN 1 AND 9007199254740991
    ),
  expected_head_sha TEXT
    CHECK (
      expected_head_sha IS NULL OR (
        length(expected_head_sha) = 40
        AND expected_head_sha GLOB '[0-9a-f]*'
        AND expected_head_sha NOT GLOB '*[^0-9a-f]*'
      )
    ),
  priority INTEGER NOT NULL
    CHECK (priority BETWEEN 0 AND 1000000),
  updated_at TEXT NOT NULL
    CHECK (
      length(updated_at) = 24
      AND updated_at GLOB '????-??-??T??:??:??.???Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    ),
  PRIMARY KEY (campaign_id, task_id),
  UNIQUE (campaign_id, issue_number),
  UNIQUE (campaign_id, active_pull_request_number),
  CHECK ((active_pull_request_number IS NULL) = (expected_head_sha IS NULL)),
  FOREIGN KEY (campaign_id, project_id, repository)
    REFERENCES continuation_campaigns(campaign_id, project_id, repository)
    ON DELETE CASCADE
);

CREATE INDEX idx_continuation_campaigns_project_gate_updated_at
  ON continuation_campaigns (project_id, human_gate, paused, updated_at);

CREATE INDEX idx_continuation_tasks_campaign_priority_issue
  ON continuation_tasks (campaign_id, priority, issue_number);
