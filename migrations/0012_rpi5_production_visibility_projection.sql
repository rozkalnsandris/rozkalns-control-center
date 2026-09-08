CREATE TABLE IF NOT EXISTS rpi5_production_visibility (
  project_id TEXT PRIMARY KEY
    CHECK (length(project_id) BETWEEN 1 AND 128),
  repository TEXT NOT NULL UNIQUE
    CHECK (length(repository) BETWEEN 3 AND 201),
  main_sha TEXT NOT NULL
    CHECK (
      length(main_sha) = 40
      AND main_sha NOT GLOB '*[^0-9a-f]*'
    ),
  production_sha TEXT NOT NULL
    CHECK (
      length(production_sha) = 40
      AND production_sha NOT GLOB '*[^0-9a-f]*'
    ),
  deploy_impact TEXT NOT NULL
    CHECK (deploy_impact IN (
      'NO_DEPLOY',
      'AUTO_DEPLOY_SAFE',
      'MANUAL_ROLLOUT_REQUIRED',
      'DB_HOST_APPLY_REQUIRED',
      'UNKNOWN'
    )),
  runtime TEXT NOT NULL
    CHECK (runtime IN ('HEALTHY', 'DEGRADED', 'UNREACHABLE', 'UNKNOWN')),
  health TEXT NOT NULL
    CHECK (health IN ('PASS', 'FAIL', 'UNKNOWN')),
  rollback TEXT NOT NULL
    CHECK (rollback IN ('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN')),
  blocker_codes_json TEXT NOT NULL
    CHECK (length(blocker_codes_json) BETWEEN 2 AND 4096),
  observed_at TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL
    CHECK (typeof(observed_at_ms) = 'integer' AND observed_at_ms > 0),
  production_adapter TEXT NOT NULL
    CHECK (production_adapter = 'rpi5'),
  drift TEXT NOT NULL
    CHECK (drift IN ('IN_SYNC', 'DRIFTED')),
  stored_at TEXT NOT NULL,
  stored_at_ms INTEGER NOT NULL
    CHECK (
      typeof(stored_at_ms) = 'integer'
      AND stored_at_ms > 0
      AND stored_at_ms >= observed_at_ms
    ),
  CHECK (
    (main_sha = production_sha AND drift = 'IN_SYNC')
    OR (main_sha <> production_sha AND drift = 'DRIFTED')
  )
);

CREATE INDEX IF NOT EXISTS idx_rpi5_production_visibility_observed_at_ms
  ON rpi5_production_visibility(observed_at_ms);
