-- Rozkalns Control planner-proven read-path index.
-- This source migration does not apply itself to local or production D1.
-- The partial predicate excludes terminal success rows to limit write and storage amplification.

CREATE INDEX idx_webhook_deliveries_active_updated_delivery
  ON webhook_deliveries (updated_at, delivery_id)
  WHERE state <> 'SUCCEEDED';
