import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationPaths = [
  "migrations/0001_reconciliation_core.sql",
  "migrations/0002_needs_changes_audit.sql",
  "migrations/0003_notification_transitions.sql",
  "migrations/0004_notification_delivery_intents.sql",
  "migrations/0005_notification_delivery_attempts.sql",
  "migrations/0006_notification_delivery_dispatch_claims.sql",
  "migrations/0007_continuation_campaigns.sql",
  "migrations/0008_merge_decision_audit.sql",
  "migrations/0009_later_deferrals.sql",
] as const;

const hotIndexMigration = "migrations/0010_webhook_observability_hot_index.sql";

const diagnosticQuery = `
SELECT
  delivery_id, repository, project_id, event_name, state, attempt_count,
  received_at, updated_at, last_error_code
FROM webhook_deliveries
WHERE state <> 'SUCCEEDED'
ORDER BY updated_at ASC, delivery_id ASC
LIMIT ?1
`.trim();

function planDetails(database: DatabaseSync, sql: string, ...bindings: Array<string | number>): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>)
    .map((row) => row.detail);
}

async function migratedDatabase(includeHotIndex: boolean): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  for (const path of migrationPaths) database.exec(await readFile(path, "utf8"));
  if (includeHotIndex) database.exec(await readFile(hotIndexMigration, "utf8"));
  return database;
}

test("0010 contains only the one planner-proven partial observability index", async () => {
  const sql = await readFile(hotIndexMigration, "utf8");
  const statements = sql
    .replaceAll(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  assert.deepEqual(statements, [
    "CREATE INDEX idx_webhook_deliveries_active_updated_delivery\n  ON webhook_deliveries (updated_at, delivery_id)\n  WHERE state <> 'SUCCEEDED'",
  ]);
  assert.doesNotMatch(statements.join("\n"), /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
});

test("0010 removes the diagnostics table scan and temporary order while using the partial index", async () => {
  const before = await migratedDatabase(false);
  const after = await migratedDatabase(true);
  try {
    const beforePlan = planDetails(before, diagnosticQuery, 51).join("\n");
    const afterPlan = planDetails(after, diagnosticQuery, 51).join("\n");

    assert.match(beforePlan, /SCAN webhook_deliveries(?:\n|$)/);
    assert.match(beforePlan, /USE TEMP B-TREE FOR ORDER BY/);
    assert.match(afterPlan, /USING INDEX idx_webhook_deliveries_active_updated_delivery/);
    assert.doesNotMatch(afterPlan, /USE TEMP B-TREE/);
  } finally {
    before.close();
    after.close();
  }
});

test("audited notification, continuation and decision readers retain indexed searches", async () => {
  const database = await migratedDatabase(true);
  try {
    const plans = [
      planDetails(database, "SELECT * FROM webhook_deliveries WHERE delivery_id = ?1 LIMIT 1", "delivery"),
      planDetails(database, "SELECT * FROM notification_delivery_attempts WHERE delivery_id = ?1 ORDER BY attempt_number", "delivery"),
      planDetails(database, "SELECT * FROM continuation_campaigns WHERE campaign_id = ?1 AND project_id = ?2 AND repository = ?3 LIMIT 2", "campaign", "project", "owner/repo"),
      planDetails(database, "SELECT * FROM continuation_tasks WHERE campaign_id = ?1 AND project_id = ?2 AND repository = ?3 ORDER BY priority, issue_number LIMIT ?4", "campaign", "project", "owner/repo", 501),
      planDetails(database, "SELECT * FROM needs_changes_decisions WHERE request_id = ?1 LIMIT 1", "request"),
      planDetails(database, "SELECT * FROM merge_decisions WHERE request_id = ?1 LIMIT 1", "request"),
      planDetails(database, "SELECT * FROM later_deferrals WHERE decision_id = ?1 LIMIT 1", "decision"),
    ].map((plan) => plan.join("\n"));

    for (const plan of plans) assert.match(plan, /SEARCH .* USING (?:COVERING )?INDEX/);
    assert.match(plans[3] ?? "", /idx_continuation_tasks_campaign_priority_issue/);
  } finally {
    database.close();
  }
});
