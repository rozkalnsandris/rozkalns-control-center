import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const coreMigrationPath = "migrations/0001_reconciliation_core.sql";
const auditMigrationPath = "migrations/0002_needs_changes_audit.sql";

async function migratedDatabase(): Promise<DatabaseSync> {
  const [core, audit] = await Promise.all([
    readFile(coreMigrationPath, "utf8"),
    readFile(auditMigrationPath, "utf8"),
  ]);
  const database = new DatabaseSync(":memory:");
  database.exec(core);
  database.exec(audit);
  return database;
}

function literal(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function decisionInsert(overrides: Partial<Record<string, string | number | null>> = {}): string {
  const values = {
    request_id: "request-123456789",
    fingerprint: "a".repeat(64),
    actor_subject: "access-user-123",
    actor_email: "andris@example.invalid",
    repository: "rozkalnsandris/hermes-deals",
    project_id: "hermes-deals",
    issue_number: 700,
    pull_number: 701,
    expected_head_sha: "b".repeat(40),
    expected_main_sha: "c".repeat(40),
    requested_at: "2026-08-16T14:29:59.000Z",
    state: "IN_PROGRESS",
    outcome_code: null,
    observed_head_sha: null,
    observed_main_sha: null,
    observed_at: null,
    review_id: null,
    review_url: null,
    submitted_at: null,
    completed_at: null,
    ...overrides,
  };

  const columns = Object.keys(values);
  return `INSERT INTO needs_changes_decisions (${columns.join(", ")}) VALUES (${columns
    .map((column) => literal(values[column as keyof typeof values]))
    .join(", ")})`;
}

test("0002 migration composes after 0001 and creates only the Needs changes audit table plus indexes", async () => {
  const database = await migratedDatabase();
  try {
    const objects = database
      .prepare(
        "SELECT name, type FROM sqlite_schema WHERE name IN ('needs_changes_decisions','idx_needs_changes_decisions_state_requested_at','idx_needs_changes_decisions_repository_pull_requested_at') ORDER BY name",
      )
      .all() as Array<{ name: string; type: string }>;

    assert.deepEqual(
      objects.map(({ name, type }) => [name, type]),
      [
        ["idx_needs_changes_decisions_repository_pull_requested_at", "index"],
        ["idx_needs_changes_decisions_state_requested_at", "index"],
        ["needs_changes_decisions", "table"],
      ],
    );

    const columns = database.prepare('PRAGMA table_info("needs_changes_decisions")').all() as Array<{ name: string }>;
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
      "expected_head_sha",
      "expected_main_sha",
      "requested_at",
      "state",
      "outcome_code",
      "observed_head_sha",
      "observed_main_sha",
      "observed_at",
      "review_id",
      "review_url",
      "submitted_at",
      "completed_at",
    ]) {
      assert.equal(names.includes(required), true, `missing ${required}`);
    }

    for (const forbidden of [
      "body",
      "review_body",
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

test("0002 accepts one valid IN_PROGRESS claim and enforces primary identity bounds", async () => {
  const database = await migratedDatabase();
  try {
    database.exec(decisionInsert());
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM needs_changes_decisions").get()?.count, 1);

    assert.throws(() => database.exec(decisionInsert({ request_id: "request-123456789" })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "short", fingerprint: "d".repeat(64) })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "request-bad-fingerprint", fingerprint: "Z".repeat(64) })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "request-bad-head-sha", expected_head_sha: "b".repeat(39) })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "request-bad-main-sha", expected_main_sha: "G".repeat(40) })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "request-bad-issue", issue_number: 0 })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "request-bad-pull", pull_number: -1 })));
    assert.throws(() => database.exec(decisionInsert({ request_id: "request-bad-state", state: "OTHER" })));
  } finally {
    database.close();
  }
});

test("0002 enforces exact terminal evidence shapes for success, failure and unknown outcomes", async () => {
  const database = await migratedDatabase();
  try {
    database.exec(decisionInsert({
      request_id: "request-success-1234",
      state: "SUCCEEDED",
      observed_head_sha: "b".repeat(40),
      observed_main_sha: "c".repeat(40),
      observed_at: "2026-08-16T14:30:00.000Z",
      review_id: "42",
      review_url: "https://github.com/rozkalnsandris/hermes-deals/pull/701#pullrequestreview-42",
      submitted_at: "2026-08-16T14:30:02.000Z",
      completed_at: "2026-08-16T14:30:03.000Z",
    }));

    database.exec(decisionInsert({
      request_id: "request-failed-12345",
      state: "FAILED",
      outcome_code: "AUTHORIZATION_STALE_HEAD",
      completed_at: "2026-08-16T14:30:03.000Z",
    }));

    database.exec(decisionInsert({
      request_id: "request-unknown-1234",
      state: "UNKNOWN",
      outcome_code: "WRITE_OUTCOME_UNKNOWN",
      completed_at: "2026-08-16T14:30:03.000Z",
    }));

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM needs_changes_decisions").get()?.count, 3);

    assert.throws(() => database.exec(decisionInsert({
      request_id: "request-bad-success1",
      state: "SUCCEEDED",
      completed_at: "2026-08-16T14:30:03.000Z",
    })));

    assert.throws(() => database.exec(decisionInsert({
      request_id: "request-bad-failed12",
      state: "FAILED",
      outcome_code: "AUDIT_FINALIZATION_FAILED",
      completed_at: "2026-08-16T14:30:03.000Z",
    })));

    assert.throws(() => database.exec(decisionInsert({
      request_id: "request-bad-failed34",
      state: "FAILED",
      outcome_code: "WRITE_REJECTED",
      observed_head_sha: "b".repeat(40),
      completed_at: "2026-08-16T14:30:03.000Z",
    })));

    assert.throws(() => database.exec(decisionInsert({
      request_id: "request-bad-unknown1",
      state: "UNKNOWN",
      outcome_code: "WRITE_REJECTED",
      completed_at: "2026-08-16T14:30:03.000Z",
    })));

    assert.throws(() => database.exec(decisionInsert({
      request_id: "request-bad-progress",
      state: "IN_PROGRESS",
      completed_at: "2026-08-16T14:30:03.000Z",
    })));
  } finally {
    database.close();
  }
});
