import { readFile } from "node:fs/promises";

const migration = await readFile("migrations/0001_reconciliation_core.sql", "utf8");

const requiredFragments = [
  "CREATE TABLE webhook_deliveries",
  "delivery_id TEXT PRIMARY KEY NOT NULL",
  "repository TEXT NOT NULL",
  "project_id TEXT NOT NULL",
  "event_name TEXT NOT NULL",
  "message_version INTEGER NOT NULL DEFAULT 1 CHECK (message_version = 1)",
  "state TEXT NOT NULL CHECK",
  "attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)",
  "state <> 'SUCCEEDED' OR completed_at IS NOT NULL",
  "state <> 'DEAD_LETTERED' OR dead_lettered_at IS NOT NULL",
  "state NOT IN ('RETRY_PENDING', 'DEAD_LETTERED') OR last_error_code IS NOT NULL",
  "CREATE INDEX idx_webhook_deliveries_state_updated_at",
  "CREATE INDEX idx_webhook_deliveries_repository_updated_at",
];

for (const fragment of requiredFragments) {
  if (!migration.includes(fragment)) {
    throw new Error(`D1 migration contract is missing: ${fragment}`);
  }
}

for (const state of ["RECEIVED", "ENQUEUED", "PROCESSING", "RETRY_PENDING", "SUCCEEDED", "DEAD_LETTERED"]) {
  if (!migration.includes(`'${state}'`)) {
    throw new Error(`D1 migration contract is missing lifecycle state: ${state}`);
  }
}

for (const forbidden of ["token", "secret", "private_key", "webhook_payload", "payload_body"]) {
  if (new RegExp(`^\\s*${forbidden}\\s+`, "im").test(migration)) {
    throw new Error(`D1 migration persists forbidden field: ${forbidden}`);
  }
}

console.log("D1_MIGRATION_CONTRACT=PASS");
