import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  D1ContinuationCampaignReader,
  D1ContinuationCampaignReaderError,
  type ContinuationCampaignRecoveryIdentity,
} from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import { MAX_CONTINUATION_CANDIDATES } from "../src/shared/continuation-plan.js";

interface PreparedCall {
  readonly sql: string;
  values: readonly unknown[];
}

class FakeD1Database implements D1DatabaseLike {
  readonly prepared: PreparedCall[] = [];
  readonly #results: D1RunResultLike[];

  constructor(results: readonly D1RunResultLike[]) {
    this.#results = [...results];
  }

  prepare(sql: string): D1PreparedStatementLike {
    const call: PreparedCall = { sql, values: [] };
    this.prepared.push(call);
    return this.#statement(call);
  }

  #statement(call: PreparedCall): D1PreparedStatementLike {
    return {
      bind: (...values: readonly unknown[]) => {
        call.values = values;
        return this.#statement(call);
      },
      run: async <Row = Record<string, unknown>>() => this.#next() as D1RunResultLike<Row>,
    };
  }

  #next(): D1RunResultLike {
    const next = this.#results.shift();
    if (!next) throw new Error("Unexpected fake D1 query");
    return next;
  }
}

class SqliteD1Database implements D1DatabaseLike {
  readonly prepared: PreparedCall[] = [];
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  prepare(sql: string): D1PreparedStatementLike {
    const call: PreparedCall = { sql, values: [] };
    this.prepared.push(call);
    return this.#statement(call);
  }

  #statement(call: PreparedCall): D1PreparedStatementLike {
    return {
      bind: (...values: readonly unknown[]) => {
        call.values = values;
        return this.#statement(call);
      },
      run: async <Row = Record<string, unknown>>() => {
        const values = call.values.map((value) => {
          if (typeof value !== "string" && typeof value !== "number") {
            throw new Error("Unexpected local SQLite bind value");
          }
          return value;
        });
        const sqliteSql = call.sql.replace(/\?[1-9]\d*/gu, "?");
        const rows = this.#database.prepare(sqliteSql).all(...values) as Row[];
        return { success: true, meta: { changes: 0 }, results: rows };
      },
    };
  }
}

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "1111111111111111111111111111111111111111";
const OBSERVED_AT = "2026-08-21T12:00:00.000Z";

const identity: ContinuationCampaignRecoveryIdentity = {
  campaignId: CAMPAIGN_ID,
  projectId: PROJECT_ID,
  repository: REPOSITORY,
  expectedMainSha: MAIN_SHA,
};

type StoredRow = Record<string, string | number | null>;

function campaign(overrides: StoredRow = {}): StoredRow {
  return {
    campaign_id: CAMPAIGN_ID,
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
  };
}

function task(overrides: StoredRow = {}): StoredRow {
  return {
    campaign_id: CAMPAIGN_ID,
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
  };
}

function result(rows: readonly StoredRow[] = [], success = true): D1RunResultLike {
  return { success, meta: { changes: 0 }, results: rows };
}

function databaseFor(
  storedCampaign: StoredRow,
  tasks: readonly StoredRow[] = [],
  finalCampaign: StoredRow = storedCampaign,
): FakeD1Database {
  return new FakeD1Database([result([storedCampaign]), result(tasks), result([finalCampaign])]);
}

function rejectionCode(code: string) {
  return (error: unknown) =>
    error instanceof D1ContinuationCampaignReaderError && error.code === code;
}

function insertRow(database: DatabaseSync, table: string, row: StoredRow): void {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const values = columns.map((column) => row[column]);
  database
    .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`)
    .run(...values);
}

test("real in-memory 0007 rows recover exact bounded campaign/tasks through three reads", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(resolve("migrations/0007_continuation_campaigns.sql"), "utf8"));

  try {
    const storedCampaign = campaign({
      current_task_id: "task:516",
      current_task_state: "DONE",
      next_task_id: "task:517",
    });
    insertRow(database, "continuation_campaigns", storedCampaign);
    insertRow(database, "continuation_tasks", task());
    insertRow(
      database,
      "continuation_tasks",
      task({ task_id: "task:516", issue_number: 516, task_state: "DONE", priority: 0 }),
    );
    insertRow(
      database,
      "continuation_tasks",
      task({
        task_id: "task:518",
        issue_number: 518,
        task_state: "REVIEW",
        active_pull_request_number: 600,
        expected_head_sha: HEAD_SHA,
        priority: 20,
      }),
    );

    const adapter = new SqliteD1Database(database);
    const recovered = await new D1ContinuationCampaignReader(adapter).read(identity);
    assert.equal(recovered.kind, "FOUND");
    if (recovered.kind !== "FOUND") return;

    assert.equal(recovered.campaign.expectedMainSha, MAIN_SHA);
    assert.deepEqual(recovered.campaign.currentTask, { taskId: "task:516", state: "DONE" });
    assert.equal(recovered.campaign.nextTaskId, "task:517");
    assert.deepEqual(
      recovered.tasks.map((entry) => entry.issueNumber),
      [516, 517, 518],
    );
    assert.equal(recovered.tasks[2].expectedHeadSha, HEAD_SHA);
    assert.equal(adapter.prepared.length, 3);
    assert.deepEqual(adapter.prepared[0].values, [CAMPAIGN_ID, PROJECT_ID, REPOSITORY]);
    assert.deepEqual(adapter.prepared[1].values, [
      CAMPAIGN_ID,
      PROJECT_ID,
      REPOSITORY,
      MAX_CONTINUATION_CANDIDATES + 1,
    ]);
    for (const query of adapter.prepared) assert.match(query.sql, /^SELECT\b/u);
  } finally {
    database.close();
  }
});

test("missing exact campaign returns NOT_FOUND after one bounded read", async () => {
  const database = new FakeD1Database([result()]);
  assert.deepEqual(await new D1ContinuationCampaignReader(database).read(identity), {
    kind: "NOT_FOUND",
  });
  assert.equal(database.prepared.length, 1);
  assert.match(database.prepared[0].sql, /LIMIT 2/u);
});

test("invalid identity, excluded repository and cross-project evidence never query D1", async () => {
  for (const [input, expected] of [
    [{ ...identity, campaignId: "../unsafe" }, "INVALID_INPUT"],
    [{ ...identity, expectedMainSha: MAIN_SHA.toUpperCase() }, "INVALID_INPUT"],
    [
      { ...identity, repository: "rozkalnsandris/hermes-email-skill" },
      "REPOSITORY_NOT_ALLOWED",
    ],
    [{ ...identity, projectId: "hermes-tech" }, "REPOSITORY_EVIDENCE_MISMATCH"],
    [
      { ...identity, repository: "ROZKALNSANDRIS/HERMES-DEALS" },
      "REPOSITORY_EVIDENCE_MISMATCH",
    ],
  ] as const) {
    const database = new FakeD1Database([]);
    await assert.rejects(
      () => new D1ContinuationCampaignReader(database).read(input),
      rejectionCode(expected),
    );
    assert.equal(database.prepared.length, 0);
  }
});

test("stored identity and expected main drift stop before the task query", async () => {
  for (const [row, expected] of [
    [campaign({ repository: "rozkalnsandris/hermes-tech" }), "REPOSITORY_EVIDENCE_MISMATCH"],
    [campaign({ project_id: "hermes-tech" }), "REPOSITORY_EVIDENCE_MISMATCH"],
    [campaign({ campaign_id: "campaign:other" }), "REPOSITORY_EVIDENCE_MISMATCH"],
    [campaign({ expected_main_sha: "f".repeat(40) }), "EXPECTED_MAIN_SHA_DRIFT"],
  ] as const) {
    const database = new FakeD1Database([result([row])]);
    await assert.rejects(
      () => new D1ContinuationCampaignReader(database).read(identity),
      rejectionCode(expected),
    );
    assert.equal(database.prepared.length, 1);
  }
});

test("invalid stored schema, mode, flags, UTC and task pairing fail before task reads", async () => {
  for (const override of [
    { schema_version: 2 },
    { scope: "   " },
    { scope: "lidl\nunsafe" },
    { mode: "AUTO_DEPLOY" },
    { continue_enabled: 2 },
    { paused: -1 },
    { expected_main_sha: MAIN_SHA.toUpperCase() },
    { current_task_id: "task:516", current_task_state: null },
    { current_task_id: null, current_task_state: "DONE" },
    { current_task_id: "task:516", current_task_state: "AUTO_MERGE" },
    { next_task_id: "../unsafe" },
    { human_gate: "AUTO_DEPLOY" },
    { observed_at: "2026-08-21T12:00:00Z" },
    { updated_at: "2026-08-21T11:59:59.999Z" },
  ] as StoredRow[]) {
    const database = new FakeD1Database([result([campaign(override)])]);
    await assert.rejects(
      () => new D1ContinuationCampaignReader(database).read(identity),
      rejectionCode("INVALID_STORED_CAMPAIGN"),
    );
    assert.equal(database.prepared.length, 1);
  }
});

test("owner gates, pause, disabled continuation and unfinished work cannot retain next task", async () => {
  for (const override of [
    { paused: 1 },
    { continue_enabled: 0 },
    { human_gate: "MERGE" },
    { human_gate: "DEPLOY" },
    { human_gate: "NEEDS_CHANGES" },
    { human_gate: "PRODUCTION_MUTATION" },
    { current_task_id: "task:516", current_task_state: "WORKING" },
    { current_task_id: "task:517", current_task_state: "DONE" },
  ] as StoredRow[]) {
    const database = new FakeD1Database([
      result([campaign({ next_task_id: "task:517", ...override })]),
    ]);
    await assert.rejects(
      () => new D1ContinuationCampaignReader(database).read(identity),
      rejectionCode("INVALID_STORED_CAMPAIGN"),
    );
    assert.equal(database.prepared.length, 1);
  }
});

test("valid explicit owner gate is preserved as inert evidence", async () => {
  const storedCampaign = campaign({ human_gate: "MERGE" });
  const recovered = await new D1ContinuationCampaignReader(
    databaseFor(storedCampaign),
  ).read(identity);
  assert.deepEqual(recovered, {
    kind: "FOUND",
    campaign: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      scope: "lidl",
      mode: "CONTINUE_ISSUES",
      continueEnabled: true,
      paused: false,
      expectedMainSha: MAIN_SHA,
      currentTask: null,
      nextTaskId: null,
      humanGate: "MERGE",
      observedAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT,
    },
    tasks: [],
  });
});

test("oversized task recovery is detected with the existing bounded limit", async () => {
  const oversized = Array.from({ length: MAX_CONTINUATION_CANDIDATES + 1 }, (_, index) =>
    task({
      task_id: `task:${index + 1}`,
      issue_number: index + 1,
      priority: index,
    }),
  );
  const database = new FakeD1Database([result([campaign()]), result(oversized)]);
  await assert.rejects(
    () => new D1ContinuationCampaignReader(database).read(identity),
    rejectionCode("TOO_MANY_TASKS"),
  );
  assert.equal(database.prepared.length, 2);
});

test("duplicate task, issue and pull request identity fails closed", async () => {
  const withPullRequest = task({
    active_pull_request_number: 600,
    expected_head_sha: HEAD_SHA,
  });
  for (const rows of [
    [task(), task({ issue_number: 518 })],
    [task(), task({ task_id: "task:518" })],
    [
      withPullRequest,
      task({
        task_id: "task:518",
        issue_number: 518,
        active_pull_request_number: 600,
        expected_head_sha: HEAD_SHA,
      }),
    ],
  ]) {
    const database = new FakeD1Database([result([campaign()]), result(rows)]);
    await assert.rejects(
      () => new D1ContinuationCampaignReader(database).read(identity),
      rejectionCode("DUPLICATE_TASK"),
    );
    assert.equal(database.prepared.length, 2);
  }
});

test("cross-campaign/project/repository task attribution never reaches final read", async () => {
  for (const override of [
    { campaign_id: "campaign:other" },
    { project_id: "hermes-tech" },
    { repository: "rozkalnsandris/hermes-tech" },
  ] as StoredRow[]) {
    const database = new FakeD1Database([
      result([campaign()]),
      result([task(override)]),
    ]);
    await assert.rejects(
      () => new D1ContinuationCampaignReader(database).read(identity),
      rejectionCode("REPOSITORY_EVIDENCE_MISMATCH"),
    );
    assert.equal(database.prepared.length, 2);
  }
});

test("malformed task state, PR/head pairing, bounds and UTC fail closed", async () => {
  for (const override of [
    { task_id: "../unsafe" },
    { issue_number: 0 },
    { issue_number: Number.MAX_SAFE_INTEGER + 1 },
    { task_state: "AUTO_DEPLOY" },
    { active_pull_request_number: 0, expected_head_sha: HEAD_SHA },
    { active_pull_request_number: 600, expected_head_sha: null },
    { active_pull_request_number: null, expected_head_sha: HEAD_SHA },
    { active_pull_request_number: 600, expected_head_sha: "A".repeat(40) },
    { priority: -1 },
    { priority: 1_000_001 },
    { updated_at: "2026-08-21T12:00:00Z" },
  ] as StoredRow[]) {
    const database = new FakeD1Database([
      result([campaign()]),
      result([task(override)]),
    ]);
    await assert.rejects(
      () => new D1ContinuationCampaignReader(database).read(identity),
      rejectionCode("INVALID_STORED_TASK"),
    );
    assert.equal(database.prepared.length, 2);
  }
});

test("non-deterministic stored task ordering is rejected", async () => {
  const rows = [
    task({ task_id: "task:518", issue_number: 518, priority: 20 }),
    task({ task_id: "task:517", issue_number: 517, priority: 10 }),
  ];
  await assert.rejects(
    () => new D1ContinuationCampaignReader(databaseFor(campaign(), rows)).read(identity),
    rejectionCode("INVALID_STORED_TASK"),
  );
});

test("current and next task references must resolve to exact eligible recovered rows", async () => {
  for (const [storedCampaign, rows] of [
    [campaign({ current_task_id: "task:516", current_task_state: "DONE" }), []],
    [
      campaign({ current_task_id: "task:516", current_task_state: "DONE" }),
      [task({ task_id: "task:516", issue_number: 516, task_state: "WORKING" })],
    ],
    [campaign({ next_task_id: "task:517" }), []],
    [campaign({ next_task_id: "task:517" }), [task({ task_state: "WORKING" })]],
    [
      campaign({ next_task_id: "task:517" }),
      [task({ active_pull_request_number: 600, expected_head_sha: HEAD_SHA })],
    ],
  ] as const) {
    await assert.rejects(
      () => new D1ContinuationCampaignReader(databaseFor(storedCampaign, rows)).read(identity),
      rejectionCode("INVALID_STORED_CAMPAIGN"),
    );
  }
});

test("campaign evidence must stay identical across the final race read", async () => {
  const initial = campaign();
  for (const final of [
    campaign({ paused: 1 }),
    campaign({ human_gate: "DEPLOY" }),
    campaign({ updated_at: "2026-08-21T12:00:01.000Z" }),
  ]) {
    const database = databaseFor(initial, [], final);
    await assert.rejects(
      () => new D1ContinuationCampaignReader(database).read(identity),
      rejectionCode("CAMPAIGN_RACE"),
    );
    assert.equal(database.prepared.length, 3);
  }

  const missing = new FakeD1Database([result([initial]), result(), result()]);
  await assert.rejects(
    () => new D1ContinuationCampaignReader(missing).read(identity),
    rejectionCode("CAMPAIGN_RACE"),
  );
});

test("unsuccessful and non-unique D1 evidence is never treated as recovered", async () => {
  const unsuccessful = new FakeD1Database([result([], false)]);
  await assert.rejects(
    () => new D1ContinuationCampaignReader(unsuccessful).read(identity),
    rejectionCode("D1_QUERY_FAILED"),
  );

  const duplicate = new FakeD1Database([result([campaign(), campaign()])]);
  await assert.rejects(
    () => new D1ContinuationCampaignReader(duplicate).read(identity),
    rejectionCode("INVALID_STORED_CAMPAIGN"),
  );
});

test("recovery stays detached, SELECT-only and free of deploy/provider/runtime wiring", () => {
  const source = readFileSync(
    resolve("src/integrations/cloudflare/d1-continuation-campaign-reader.ts"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /\b(?:INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|REPLACE\s+INTO|ALTER\s+TABLE|CREATE\s+TABLE)\b/iu,
  );
  assert.doesNotMatch(
    source,
    /(?:CONTROL_NOTIFICATION_|CLOUDFLARE_API_TOKEN|GITHUB_TOKEN|wrangler\s+deploy|workflow_dispatch)/iu,
  );
  assert.doesNotMatch(source, /(?:telegram|web_push|provider_send|private_key)/iu);
  assert.match(source, /FROM continuation_campaigns/u);
  assert.match(source, /FROM continuation_tasks/u);
});
