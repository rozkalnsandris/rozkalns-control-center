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

async function migratedDatabase(): Promise<DatabaseSync> {
  const migrations = await Promise.all(migrationPaths.map((path) => readFile(path, "utf8")));
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration);
  return database;
}

function insertDeferral(
  database: DatabaseSync,
  overrides: Partial<{
    decisionId: string;
    schemaVersion: number;
    projectId: string;
    issueNumber: number | null;
    prNumber: number | null;
    fingerprint: string;
    deferredAt: string;
    actorSubject: string;
    actorEmail: string | null;
  }> = {},
): void {
  const values = {
    decisionId: "decision-hermes-deals-783",
    schemaVersion: 1,
    projectId: "hermes-deals",
    issueNumber: 782,
    prNumber: 783,
    fingerprint: `later-v1-${"a".repeat(16)}`,
    deferredAt: "2026-08-28T07:45:00.000Z",
    actorSubject: "access-user-123",
    actorEmail: "andris@example.invalid",
    ...overrides,
  };

  database
    .prepare(
      `INSERT INTO later_deferrals (
        decision_id, schema_version, project_id, issue_number, pr_number,
        state_fingerprint, deferred_at, actor_subject, actor_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.decisionId,
      values.schemaVersion,
      values.projectId,
      values.issueNumber,
      values.prNumber,
      values.fingerprint,
      values.deferredAt,
      values.actorSubject,
      values.actorEmail,
    );
}

test("0009 composes after 0001-0008 and creates only the dormant Later table and index", async () => {
  const database = await migratedDatabase();
  try {
    const objects = database
      .prepare(
        "SELECT name, type FROM sqlite_schema WHERE name IN ('later_deferrals','idx_later_deferrals_project_deferred_at') ORDER BY name",
      )
      .all() as Array<{ name: string; type: string }>;

    assert.deepEqual(
      objects.map(({ name, type }) => [name, type]),
      [
        ["idx_later_deferrals_project_deferred_at", "index"],
        ["later_deferrals", "table"],
      ],
    );

    const columns = database.prepare('PRAGMA table_info("later_deferrals")').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    for (const required of [
      "decision_id",
      "schema_version",
      "project_id",
      "issue_number",
      "pr_number",
      "state_fingerprint",
      "deferred_at",
      "actor_subject",
      "actor_email",
    ]) {
      assert.equal(names.includes(required), true, `missing ${required}`);
    }

    for (const forbidden of [
      "access_jwt",
      "github_token",
      "token",
      "secret",
      "private_key",
      "request_body",
      "webhook_payload",
    ]) {
      assert.equal(names.includes(forbidden), false, `forbidden ${forbidden}`);
    }
  } finally {
    database.close();
  }
});

test("0009 enforces one active row per decision and bounded fingerprint/identity constraints", async () => {
  const database = await migratedDatabase();
  try {
    insertDeferral(database);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM later_deferrals").get()?.count, 1);

    assert.throws(() => insertDeferral(database));
    assert.throws(() => insertDeferral(database, { decisionId: "", fingerprint: `later-v1-${"b".repeat(16)}` }));
    assert.throws(() => insertDeferral(database, { decisionId: "x".repeat(257), fingerprint: `later-v1-${"b".repeat(16)}` }));
    assert.throws(() => insertDeferral(database, { decisionId: "decision-bad-project", projectId: "", fingerprint: `later-v1-${"b".repeat(16)}` }));
    assert.throws(() => insertDeferral(database, { decisionId: "decision-bad-schema", schemaVersion: 2, fingerprint: `later-v1-${"b".repeat(16)}` }));
    assert.throws(() => insertDeferral(database, { decisionId: "decision-bad-issue", issueNumber: 0, fingerprint: `later-v1-${"b".repeat(16)}` }));
    assert.throws(() => insertDeferral(database, { decisionId: "decision-bad-pr", prNumber: -1, fingerprint: `later-v1-${"b".repeat(16)}` }));
    assert.throws(() => insertDeferral(database, { decisionId: "decision-bad-fingerprint-1", fingerprint: "later-v1-short" }));
    assert.throws(() => insertDeferral(database, { decisionId: "decision-bad-fingerprint-2", fingerprint: `later-v1-${"G".repeat(16)}` }));
    assert.throws(() => insertDeferral(database, { decisionId: "decision-bad-actor", actorSubject: "", fingerprint: `later-v1-${"b".repeat(16)}` }));
  } finally {
    database.close();
  }
});

test("0009 permits nullable issue/PR and actor email without storing protected credential fields", async () => {
  const database = await migratedDatabase();
  try {
    insertDeferral(database, {
      decisionId: "decision-project-only",
      issueNumber: null,
      prNumber: null,
      actorEmail: null,
    });

    const row = database
      .prepare(
        "SELECT issue_number, pr_number, actor_email FROM later_deferrals WHERE decision_id = ?",
      )
      .get("decision-project-only") as {
      issue_number: number | null;
      pr_number: number | null;
      actor_email: string | null;
    };

    assert.equal(row.issue_number, null);
    assert.equal(row.pr_number, null);
    assert.equal(row.actor_email, null);
  } finally {
    database.close();
  }
});
