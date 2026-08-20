-- Rozkalns Control Phase 4 source-only provider-neutral dispatch-claim evidence.
-- This migration file does not apply itself to local or production D1.
-- Provider credentials, destination tokens, privileged action tokens and private evidence are intentionally excluded.

CREATE TABLE notification_delivery_dispatch_claims (
  dispatch_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(dispatch_id) = 30
      AND dispatch_id GLOB 'dispatch-v1-[0-9a-f]*'
      AND dispatch_id NOT GLOB '*[^a-z0-9-]*'
    ),
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  delivery_id TEXT NOT NULL
    CHECK (
      length(delivery_id) = 28
      AND delivery_id GLOB 'delivery-v1-[0-9a-f]*'
      AND delivery_id NOT GLOB '*[^a-z0-9-]*'
    ),
  attempt_number INTEGER NOT NULL
    CHECK (attempt_number BETWEEN 1 AND 8),
  transition_id TEXT NOT NULL
    CHECK (
      length(transition_id) BETWEEN 32 AND 80
      AND transition_id GLOB '[a-z0-9]*'
      AND transition_id NOT GLOB '*[^a-z0-9-]*'
    ),
  target_key TEXT NOT NULL
    CHECK (
      length(target_key) BETWEEN 1 AND 64
      AND target_key GLOB '[a-z0-9]*'
      AND target_key NOT GLOB '*[^a-z0-9._:-]*'
    ),
  attempted_at TEXT NOT NULL
    CHECK (
      length(attempted_at) BETWEEN 20 AND 24
      AND substr(attempted_at, -1, 1) = 'Z'
    ),
  UNIQUE (delivery_id, attempt_number),
  FOREIGN KEY (delivery_id)
    REFERENCES notification_delivery_intents(delivery_id)
    ON DELETE RESTRICT
);
