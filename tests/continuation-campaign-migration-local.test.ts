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
] as const;

const REPOSITORY = "rozkalnsandris/hermes-deals";
const PROJECT_ID = "hermes-deals";
const MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "1111111111111111111111111111111111111111";
const OBSERVED_AT = "2026-08-21T12:00:00.000Z";

type SqlValue = string | number | null;

async function migratedDatabase(): Promise<DatabaseSync> {
  const migrations = await Promise.all(migrationPaths.map((path) => readFile(path, "utf8")));
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) database.exec(migration);
  return database;
}

function literal(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function insert(table: string, values: Record<string, SqlValue>): string {
  const columns = Object.keys(values);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
    .map((column) => literal(values[column] ?? null))
    .join(", ")})`;
}

function campaign(overrides: Partial<Record<string, SqlValue>> = {}): string {
  return insert("continuation_campaigns", {
    campaign_id: "campaign:deals:lidl",
    schema_version: 1,
    project_id: PROJECT_ID,
    repository: REPOSITORY,
    scope: "lidl",
    mode: "CONTINUE_ISSUES",
    continue_enabled: 1,
    paused: 0,
    expected_main_sha: MAIN_SHA,
    current_task_id: null,
    current_task_state: null,
    next_task_id: null,
    human_gate: null,
    observed_at: OBSERVED_AT,
    updated_at: OBSERVED_AT,
    ...overrides,
  });
}

function task(overrides: Partial<Record<string, SqlValue>> = {}): string {
  return insert("continuation_tasks", {
    campaign_id: "campaign:deals:lidl",
    task_id: "task:517",
    project_id: PROJECT_ID,
    repository: REPOSITORY,
    issue_number: 517,
    task_state: "DISCOVERED",
    active_pull_request_number: null,
    expected_head_sha: null,
    priority: 10,
    updated_at: OBSERVED_AT,
    ...overrides,
  });
}

test("0007 composes after 0001–0006 and creates only bounded campaign/task durability", async () => {
  const database = await migratedDatabase();
  try {
    const objects = database
      .prepare(
        "SELECT name, type FROM sqlite_schema WHERE name IN ('continuation_campaigns','continuation_tasks','idx_continuation_campaigns_project_gate_updated_at','idx_continuation_tasks_campaign_priority_issue') ORDER BY name",
      )
      .all() as Array<{ name: string; type: string }>;

    assert.deepEqual(
      objects.map(({ name, type }) => [name, type]),
      [
        ["continuation_campaigns", "table"],
        ["continuation_tasks", "table"],
        ["idx_continuation_campaigns_project_gate_updated_at", "index"],
        ["idx_continuation_tasks_campaign_priority_issue", "index"],
      ],
    );

    for (const table of ["continuation_campaigns", "continuation_tasks"]) {
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
      }>;
      const names = columns.map((column) => column.name);
      for (const forbidden of [
        "token",
        "secret",
        "private_key",
        "credential",
        "provider_destination",
        "notification_target",
        "payload_body",
        "approval_token",
      ]) {
        assert.equal(names.includes(forbidden), false, `${table} contains ${forbidden}`);
      }
    }
  } finally {
    database.close();
  }
});

test("one campaign and exact-attributed tasks survive a local restart-safe read", async () => {
  const database = await migratedDatabase();
  try {
    database.exec(campaign());
    database.exec(task());

    const row = database
      .prepare(
        "SELECT c.campaign_id, c.repository, c.expected_main_sha, t.task_id, t.issue_number, t.priority FROM continuation_campaigns c JOIN continuation_tasks t ON t.campaign_id = c.campaign_id",
      )
      .get();

    assert.deepEqual(
      { ...row },
      {
        campaign_id: "campaign:deals:lidl",
        repository: REPOSITORY,
        expected_main_sha: MAIN_SHA,
        task_id: "task:517",
        issue_number: 517,
        priority: 10,
      },
    );
  } finally {
    database.close();
  }
});

test("campaign identity, mode, flags and exact lowercase main SHA fail closed", async () => {
  const database = await migratedDatabase();
  try {
    for (const [index, override] of [
      { campaign_id: "../unsafe" },
      { schema_version: 2 },
      { project_id: "Hermes Deals" },
      { repository: "RozkalnsAndris/hermes-deals" },
      { repository: "rozkalnsandris/hermes/deals" },
      { scope: "   " },
      { scope: "lidl\nunsafe" },
      { mode: "AUTO_DEPLOY" },
      { continue_enabled: 2 },
      { paused: -1 },
      { expected_main_sha: MAIN_SHA.toUpperCase() },
      { expected_main_sha: MAIN_SHA.slice(1) },
      { human_gate: "AUTO_MERGE" },
    ].entries()) {
      assert.throws(() => database.exec(campaign(override)), `invalid campaign ${index}`);
    }

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM continuation_campaigns").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("current task identity/state must be paired and stay inside reviewed state vocabulary", async () => {
  const database = await migratedDatabase();
  try {
    for (const override of [
      { current_task_id: "task:516", current_task_state: null },
      { current_task_id: null, current_task_state: "DONE" },
      { current_task_id: "task:516", current_task_state: "AUTO_DEPLOY" },
      { current_task_id: "../unsafe", current_task_state: "DONE" },
    ]) {
      assert.throws(() => database.exec(campaign(override)));
    }

    database.exec(campaign({ current_task_id: "task:516", current_task_state: "DONE" }));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM continuation_campaigns").get()?.count, 1);
  } finally {
    database.close();
  }
});

test("paused, disabled, owner-gated and unfinished campaigns cannot retain a next task", async () => {
  const database = await migratedDatabase();
  try {
    for (const override of [
      { paused: 1 },
      { continue_enabled: 0 },
      { human_gate: "MERGE" },
      { human_gate: "DEPLOY" },
      { human_gate: "NEEDS_CHANGES" },
      { human_gate: "PRODUCTION_MUTATION" },
      { current_task_id: "task:516", current_task_state: "WORKING" },
      { current_task_id: "task:517", current_task_state: "DONE" },
    ]) {
      assert.throws(() => database.exec(campaign({ next_task_id: "task:517", ...override })));
    }

    database.exec(
      campaign({
        current_task_id: "task:516",
        current_task_state: "DONE",
        next_task_id: "task:517",
      }),
    );
    assert.equal(database.prepare("SELECT next_task_id FROM continuation_campaigns").get()?.next_task_id, "task:517");
  } finally {
    database.close();
  }
});

test("canonical millisecond UTC evidence and observation ordering are mandatory", async () => {
  const database = await migratedDatabase();
  try {
    for (const override of [
      { observed_at: "2026-08-21T12:00:00Z" },
      { observed_at: "2026-99-21T12:00:00.000Z" },
      { updated_at: "2026-08-21T11:59:59.999Z" },
      { updated_at: "2026-08-21T12:00:00+00:00" },
    ]) {
      assert.throws(() => database.exec(campaign(override)));
    }
  } finally {
    database.close();
  }
});

test("task foreign keys require an exact campaign/project/repository and cascade safely", async () => {
  const database = await migratedDatabase();
  try {
    assert.throws(() => database.exec(task()));
    database.exec(campaign());

    assert.throws(() => database.exec(task({ project_id: "hermes-tech" })));
    assert.throws(() => database.exec(task({ repository: "rozkalnsandris/hermes-tech" })));
    database.exec(task());
    database.exec("DELETE FROM continuation_campaigns WHERE campaign_id = 'campaign:deals:lidl'");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM continuation_tasks").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("issue, task and active PR identity stay unique within the exact campaign", async () => {
  const database = await migratedDatabase();
  try {
    database.exec(campaign());
    database.exec(task({ active_pull_request_number: 600, expected_head_sha: HEAD_SHA }));

    assert.throws(() => database.exec(task({ task_id: "task:other", issue_number: 517 })));
    assert.throws(() => database.exec(task({ issue_number: 518 })));
    assert.throws(() =>
      database.exec(
        task({
          task_id: "task:518",
          issue_number: 518,
          active_pull_request_number: 600,
          expected_head_sha: HEAD_SHA,
        }),
      ),
    );
  } finally {
    database.close();
  }
});

test("active PR and exact expected head are inseparable; invalid bounds never persist", async () => {
  const database = await migratedDatabase();
  try {
    database.exec(campaign());

    for (const override of [
      { issue_number: 0 },
      { task_state: "AUTO_MERGE" },
      { task_id: "../unsafe" },
      { priority: -1 },
      { priority: 1000001 },
      { active_pull_request_number: 600, expected_head_sha: null },
      { active_pull_request_number: null, expected_head_sha: HEAD_SHA },
      { active_pull_request_number: 600, expected_head_sha: "A".repeat(40) },
      { active_pull_request_number: 0, expected_head_sha: HEAD_SHA },
      { updated_at: "2026-08-21T12:00:00Z" },
    ]) {
      assert.throws(() => database.exec(task(override)));
    }

    database.exec(task({ active_pull_request_number: 600, expected_head_sha: HEAD_SHA }));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM continuation_tasks").get()?.count, 1);
  } finally {
    database.close();
  }
});

test("migration stays schema-only with no provider/runtime/deploy or data-write command", async () => {
  const sql = await readFile("migrations/0007_continuation_campaigns.sql", "utf8");

  assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|ATTACH\s+DATABASE)\b/iu);
  assert.doesNotMatch(sql, /(?:CONTROL_NOTIFICATION_|CLOUDFLARE_API_TOKEN|GITHUB_TOKEN|wrangler\s+deploy)/iu);
  assert.doesNotMatch(sql, /(?:telegram|web_push|provider_send|private_key)/iu);
});
