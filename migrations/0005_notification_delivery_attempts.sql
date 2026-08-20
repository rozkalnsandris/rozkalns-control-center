-- Rozkalns Control Phase 4 source-only provider-neutral delivery-attempt evidence.
-- This migration file does not apply itself to local or production D1.
-- Provider credentials, destination tokens, privileged action tokens and private evidence are intentionally excluded.

CREATE TABLE notification_delivery_attempts (
  delivery_id TEXT NOT NULL
    CHECK (length(delivery_id) = 28 AND delivery_id LIKE 'delivery-v1-%'),
  attempt_number INTEGER NOT NULL
    CHECK (attempt_number BETWEEN 1 AND 8),
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  attempted_at TEXT NOT NULL,
  result_kind TEXT NOT NULL
    CHECK (result_kind IN ('DELIVERED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE')),
  result_reason TEXT,
  PRIMARY KEY (delivery_id, attempt_number),
  FOREIGN KEY (delivery_id)
    REFERENCES notification_delivery_intents(delivery_id)
    ON DELETE RESTRICT,
  CHECK (
    (result_kind = 'DELIVERED' AND result_reason IS NULL)
    OR (
      result_kind = 'RETRYABLE_FAILURE'
      AND result_reason IN ('RATE_LIMITED', 'TRANSIENT_UPSTREAM', 'PROVIDER_UNAVAILABLE')
    )
    OR (
      result_kind = 'TERMINAL_FAILURE'
      AND result_reason IN ('DESTINATION_INVALID', 'PAYLOAD_REJECTED', 'AUTHORIZATION_FAILED')
    )
  )
);
