import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationPath = "migrations/0001_reconciliation_core.sql";

function openMigratedDatabase(sql: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(sql);
  return database;
}

function insertSql(overrides: Partial<Record<string, string | number | null>> = {}): string {
  const values = {
    delivery_id: "delivery-1",
    repository: "rozkalnsandris/hermes-deals",
    project_id: "hermes-deals",
    event_name: "pull_request",
    message_version: 1,
    state: "RECEIVED",
    attempt_count: 0,
    received_at: "2026-08-13T20:20:00.000Z",
    updated_at: "2026-08-13T20:20:00.000Z",
    completed_at: null,
    dead_lettered_at: null,
    last_error_code: null,
    ...overrides,
  };

  const literal = (value: string | number | null) => {
    if (value === null) return "NULL";
    if (typeof value === "number") return String(value);
    return `'${value.replaceAll("'", "''")}'`;
  };

  return `
    INSERT INTO webhook_deliveries (
      delivery_id, repository, project_id, event_name, message_version, state,
      attempt_count, received_at, updated_at, completed_at, dead_lettered_at, last_error_code
    ) VALUES (
      ${literal(values.delivery_id)}, ${literal(values.repository)}, ${literal(values.project_id)},
      ${literal(values.event_name)}, ${literal(values.message_version)}, ${literal(values.state)},
      ${literal(values.attempt_count)}, ${literal(values.received_at)}, ${literal(values.updated_at)},
      ${literal(values.completed_at)}, ${literal(values.dead_lettered_at)}, ${literal(values.last_error_code)}
    )
  `;
}

test("D1 migration executes locally and creates the durable delivery table plus indexes", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const database = openMigratedDatabase(sql);

  try {
    const objects = database
      .prepare(
        "SELECT name, type FROM sqlite_schema WHERE name IN ('webhook_deliveries','idx_webhook_deliveries_state_updated_at','idx_webhook_deliveries_repository_updated_at') ORDER BY name",
      )
      .all() as Array<{ name: string; type: string }>;

    assert.deepEqual(
      objects.map((row) => ({ name: row.name, type: row.type })),
      [
        { name: "idx_webhook_deliveries_repository_updated_at", type: "index" },
        { name: "idx_webhook_deliveries_state_updated_at", type: "index" },
        { name: "webhook_deliveries", type: "table" },
      ],
    );

    const columns = database.prepare('PRAGMA table_info("webhook_deliveries")').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    assert.equal(names.includes("delivery_id"), true);
    assert.equal(names.includes("repository"), true);
    assert.equal(names.includes("project_id"), true);
    assert.equal(names.includes("event_name"), true);
    for (const forbidden of ["token", "secret", "private_key", "webhook_payload", "payload_body"]) {
      assert.equal(names.includes(forbidden), false);
    }
  } finally {
    database.close();
  }
});

test("D1 migration accepts a valid RECEIVED row and enforces lifecycle constraints", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const database = openMigratedDatabase(sql);

  try {
    database.exec(insertSql());
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries").get()?.count,
      1,
    );

    assert.throws(() => database.exec(insertSql({ delivery_id: "bad-state", state: "UNKNOWN" })));
    assert.throws(() => database.exec(insertSql({ delivery_id: "bad-attempt", attempt_count: -1 })));
    assert.throws(() => database.exec(insertSql({ delivery_id: "bad-version", message_version: 2 })));
    assert.throws(() => database.exec(insertSql({ delivery_id: "bad-success", state: "SUCCEEDED" })));
    assert.throws(() => database.exec(insertSql({ delivery_id: "bad-dead", state: "DEAD_LETTERED" })));
    assert.throws(() => database.exec(insertSql({ delivery_id: "bad-retry", state: "RETRY_PENDING" })));
  } finally {
    database.close();
  }
});
