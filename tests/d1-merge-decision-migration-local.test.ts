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
] as const;

async function migratedDatabase(): Promise<DatabaseSync> {
  const migrations = await Promise.all(migrationPaths.map((path) => readFile(path, "utf8")));
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration);
  return database;
}

function literal(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function decisionInsert(overrides: Partial<Record<string, string | number | null>> = {}): string {
  const values = {
    request_id: "merge-request-12345",
    fingerprint: "a".repeat(64),
    actor_subject: "access-user-123",
    actor_email: "andris@example.invalid",
    repository: "rozkalnsandris/hermes-deals",
    project_id: "hermes-deals",
    issue_number: 700,
    pull_number: 701,
    merge_method: "merge",
    expected_head_sha: "b".repeat(40),
    expected_main_sha: "c".repeat(40),
    requested_at: "2026-08-24T13:09:59.000Z",
    state: "IN_PROGRESS",
    outcome_code: null,
    mutation_attempted: null,
    observed_head_sha: null,
    observed_main_sha: null,
    observed_at: null,
    merge_sha: null,
    completed_at: null,
    ...overrides,
  };

  const columns = Object.keys(values);
  return `INSERT INTO merge_decisions (${columns.join(", ")}) VALUES (${columns
    .map((column) => literal(values[column as keyof typeof values]))
    .join(", ")})`;
}

test("0008 composes after 0001-0007 and creates only the dormant Merge audit table plus indexes", async () => {
  const database = await migratedDatabase();
  try {
    const objects = database
      .prepare(
        "SELECT name, type FROM sqlite_schema WHERE name IN ('merge_decisions','idx_merge_decisions_state_requested_at','idx_merge_decisions_repository_pull_requested_at') ORDER BY name",
      )
      .all() as Array<{ name: string; type: string }>;

    assert.deepEqual(
      objects.map(({ name, type }) => [name, type]),
      [
        ["idx_merge_decisions_repository_pull_requested_at", "index"],
        ["idx_merge_decisions_state_requested_at", "index"],
        ["merge_decisions", "table"],
      ],
    );

    const columns = database.prepare('PRAGMA table_info("merge_decisions")').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    for (const required of [
      "request_id",
      "fingerprint",
      "actor_subject",
      "actor_email",
      "repository",
      "project_id",
      "issue_number",
      "pull_number",
      "merge_method",
      "expected_head_sha",
      "expected_main_sha",
      "requested_at",
      "state",
      "outcome_code",
      "mutation_attempted",
      "observed_head_sha",
      "observed_main_sha",
      "observed_at",
      "merge_sha",
      "completed_at",
    ]) {
      assert.equal(names.includes(required), true, `missing ${required}`);
    }

    for (const forbidden of [
      "body",
      "request_body",
      "access_jwt",
      "github_token",
      "token",
      "secret",
      "private_key",
      "webhook_payload",
    ]) {
      assert.equal(names.includes(forbidden), false, `forbidden ${forbidden}`);
    }
  } finally {
    database.close();
  }
});

test("0008 accepts one bounded IN_PROGRESS claim and enforces identity/method bounds", async () => {
  const database = await migratedDatabase();
  try {
    database.exec(decisionInsert());
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM merge_decisions").get()?.count, 1);

    assert.throws(() => database.exec(decisionInsert({ request_id: "merge-request-12345" })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "short", fingerprint: "d".repeat(64) })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "merge-bad-fingerprint", fingerprint: "Z".repeat(64) })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "merge-bad-head-sha", expected_head_sha: "b".repeat(39) })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "merge-bad-main-sha", expected_main_sha: "G".repeat(40) })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "merge-bad-method-1", merge_method: "octopus" })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "merge-bad-issue-12", issue_number: 0 })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "merge-bad-pull-123", pull_number: -1 })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "merge-bad-state-12", state: "OTHER" })));
  } finally {
    database.close();
  }
});

test("0008 enforces success, known-failure and unknown mutation-evidence shapes", async () => {
  const database = await migratedDatabase();
  try {
    database.exec(decisionInsert({
      request_id: "merge-success-1234",
      state: "SUCCEEDED",
      mutation_attempted: 1,
      observed_head_sha: "b".repeat(40),
      observed_main_sha: "c".repeat(40),
      observed_at: "2026-08-24T13:10:00.000Z",
      merge_sha: "d".repeat(40),
      completed_at: "2026-08-24T13:10:02.000Z",
    }));

    database.exec(decisionInsert({
      request_id: "merge-failed-pre12",
      state: "FAILED",
      outcome_code: "DECISION_NOT_READY",
      mutation_attempted: 0,
      completed_at: "2026-08-24T13:10:02.000Z",
    }));

    database.exec(decisionInsert({
      request_id: "merge-failed-post1",
      state: "FAILED",
      outcome_code: "WRITE_REJECTED",
      mutation_attempted: 1,
      completed_at: "2026-08-24T13:10:02.000Z",
    }));

    database.exec(decisionInsert({
      request_id: "merge-unknown-1234",
      state: "UNKNOWN",
      outcome_code: "WRITE_OUTCOME_UNKNOWN",
      mutation_attempted: 1,
      completed_at: "2026-08-24T13:10:02.000Z",
    }));

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM merge_decisions").get()?.count, 4);

    assert.throws(() => database.exec(decisionInsert({
      request_id: "merge-bad-success1",
      state: "SUCCEEDED",
      mutation_attempted: 0,
      observed_head_sha: "b".repeat(40),
      observed_main_sha: "c".repeat(40),
      observed_at: "2026-08-24T13:10:00.000Z",
      merge_sha: "d".repeat(40),
      completed_at: "2026-08-24T13:10:02.000Z",
    })));

    assert.throws(() => database.exec(decisionInsert({
      request_id: "merge-bad-failed12",
      state: "FAILED",
      outcome_code: "AUDIT_FINALIZATION_FAILED",
      mutation_attempted: 1,
      completed_at: "2026-08-24T13:10:02.000Z",
    })));

    assert.throws(() => database.exec(decisionInsert({
      request_id: "merge-bad-unknown1",
      state: "UNKNOWN",
      outcome_code: "WRITE_OUTCOME_UNKNOWN",
      mutation_attempted: 0,
      completed_at: "2026-08-24T13:10:02.000Z",
    })));

    assert.throws(() => database.exec(decisionInsert({
      request_id: "merge-bad-progress",
      state: "IN_PROGRESS",
      mutation_attempted: 0,
    })));
  } finally {
    database.close();
  }
});
