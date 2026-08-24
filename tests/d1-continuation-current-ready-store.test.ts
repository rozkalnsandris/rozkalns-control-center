import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  D1ContinuationCurrentReadyStore,
  D1ContinuationCurrentReadyStoreError,
  type D1BatchDatabaseLike,
} from "../src/integrations/cloudflare/d1-continuation-current-ready-store.js";
import {
  planContinuationCurrentReadyTransition,
  type ContinuationCurrentReadyTransitionProposal,
} from "../src/integrations/cloudflare/continuation-current-ready-transition.js";
import type { ContinuationCampaignRecoveryEvidence } from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";
import type {
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const COMPLETED_TASK_ID = "task:517";
const NEXT_TASK_ID = "task:518";
const OTHER_TASK_ID = "task:519";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const RESERVED_AT = "2026-08-24T15:30:00.000Z";
const READY_AT = "2026-08-24T15:31:00.000Z";
const DRIFT_AT = "2026-08-24T15:32:00.000Z";

interface SqliteStatementLike {
  all(...values: unknown[]): unknown[];
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes: number | bigint };
}

interface BatchOptions {
  readonly beforeBatch?: (() => void) | null;
  readonly afterBatch?: (() => void) | null;
  readonly failBatch?: boolean;
  readonly forcedResults?: readonly D1RunResultLike[];
}

function sqliteBindings(query: string, values: readonly unknown[]): readonly unknown[] {
  if (!/\?[1-9]\d*/u.test(query)) return values;
  return [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))];
}

class SqliteBatchPreparedStatement implements D1PreparedStatementLike {
  readonly #database: DatabaseSync;
  readonly #query: string;
  readonly #values: readonly unknown[];

  constructor(database: DatabaseSync, query: string, values: readonly unknown[] = []) {
    this.#database = database;
    this.#query = query;
    this.#values = values;
  }

  bind(...values: readonly unknown[]): D1PreparedStatementLike {
    return new SqliteBatchPreparedStatement(this.#database, this.#query, values);
  }

  execute<Row = Record<string, unknown>>(): D1RunResultLike<Row> {
    const statement = this.#database.prepare(this.#query) as unknown as SqliteStatementLike;
    const boundValues = sqliteBindings(this.#query, this.#values);
    if (/^\s*SELECT\b/i.test(this.#query)) {
      return {
        success: true,
        meta: { changes: 0 },
        results: statement.all(...boundValues) as Row[],
      };
    }
    const result = statement.run(...boundValues);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    };
  }

  async run<Row = Record<string, unknown>>(): Promise<D1RunResultLike<Row>> {
    return this.execute<Row>();
  }
}

class SqliteBatchDatabase implements D1BatchDatabaseLike {
  readonly #database: DatabaseSync;
  readonly #options: BatchOptions;
  batchCalls = 0;

  constructor(database: DatabaseSync, options: BatchOptions = {}) {
    this.#database = database;
    this.#options = options;
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqliteBatchPreparedStatement(this.#database, query);
  }

  async batch(
    statements: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1RunResultLike[]> {
    this.batchCalls += 1;
    this.#options.beforeBatch?.();
    if (this.#options.failBatch === true) throw new Error("forced batch failure");
    if (this.#options.forcedResults) return this.#options.forcedResults;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        assert.ok(statement instanceof SqliteBatchPreparedStatement);
        return statement.execute();
      });
      this.#database.exec("COMMIT");
      this.#options.afterBatch?.();
      return results;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function sqliteStatement(database: DatabaseSync, sql: string): SqliteStatementLike {
  return database.prepare(sql) as unknown as SqliteStatementLike;
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(
    readFileSync(resolve(process.cwd(), "migrations/0007_continuation_campaigns.sql"), "utf8"),
  );
  return database;
}

function expectedRecovery(): ContinuationCampaignRecoveryEvidence & { readonly kind: "FOUND" } {
  return {
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
      currentTask: { taskId: COMPLETED_TASK_ID, state: "DONE" },
      nextTaskId: NEXT_TASK_ID,
      humanGate: null,
      observedAt: RESERVED_AT,
      updatedAt: RESERVED_AT,
    },
    tasks: [
      {
        taskId: COMPLETED_TASK_ID,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: 517,
        taskState: "DONE",
        activePullRequestNumber: null,
        expectedHeadSha: null,
        priority: 10,
        updatedAt: RESERVED_AT,
      },
      {
        taskId: NEXT_TASK_ID,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: 518,
        taskState: "DISCOVERED",
        activePullRequestNumber: null,
        expectedHeadSha: null,
        priority: 20,
        updatedAt: "2026-08-24T15:29:00.000Z",
      },
      {
        taskId: OTHER_TASK_ID,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: 519,
        taskState: "READY",
        activePullRequestNumber: null,
        expectedHeadSha: null,
        priority: 30,
        updatedAt: "2026-08-24T15:28:00.000Z",
      },
    ],
  };
}

function target(
  expected: ContinuationCampaignRecoveryEvidence & { readonly kind: "FOUND" },
): ContinuationCurrentReadyTransitionProposal {
  return planContinuationCurrentReadyTransition(expected, {
    kind: "READY",
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: NEXT_TASK_ID,
    issueNumber: 518,
    expectedMainSha: MAIN_SHA,
    observedAt: READY_AT,
  });
}

function seed(
  database: DatabaseSync,
  expected: ContinuationCampaignRecoveryEvidence & { readonly kind: "FOUND" },
): void {
  const campaign = expected.campaign;
  sqliteStatement(
    database,
    `INSERT INTO continuation_campaigns (
      campaign_id, schema_version, project_id, repository, scope, mode,
      continue_enabled, paused, expected_main_sha, current_task_id,
      current_task_state, next_task_id, human_gate, observed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    campaign.campaignId,
    campaign.schemaVersion,
    campaign.projectId,
    campaign.repository,
    campaign.scope,
    campaign.mode,
    campaign.continueEnabled ? 1 : 0,
    campaign.paused ? 1 : 0,
    campaign.expectedMainSha,
    campaign.currentTask?.taskId ?? null,
    campaign.currentTask?.state ?? null,
    campaign.nextTaskId,
    campaign.humanGate,
    campaign.observedAt,
    campaign.updatedAt,
  );

  const insertTask = sqliteStatement(
    database,
    `INSERT INTO continuation_tasks (
      campaign_id, task_id, project_id, repository, issue_number, task_state,
      active_pull_request_number, expected_head_sha, priority, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const task of expected.tasks) {
    insertTask.run(
      campaign.campaignId,
      task.taskId,
      task.projectId,
      task.repository,
      task.issueNumber,
      task.taskState,
      task.activePullRequestNumber,
      task.expectedHeadSha,
      task.priority,
      task.updatedAt,
    );
  }
}

function campaignRow(database: DatabaseSync): Record<string, unknown> {
  return sqliteStatement(
    database,
    `SELECT current_task_id, current_task_state, next_task_id, human_gate,
            expected_main_sha, observed_at, updated_at
     FROM continuation_campaigns WHERE campaign_id = ?`,
  ).get(CAMPAIGN_ID) as Record<string, unknown>;
}

function taskRows(database: DatabaseSync): readonly Record<string, unknown>[] {
  return sqliteStatement(
    database,
    `SELECT task_id, issue_number, task_state, active_pull_request_number,
            expected_head_sha, priority, updated_at
     FROM continuation_tasks WHERE campaign_id = ?
     ORDER BY priority ASC, issue_number ASC`,
  ).all(CAMPAIGN_ID) as Record<string, unknown>[];
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof D1ContinuationCurrentReadyStoreError && error.code === code;
}

test("exact current READY transition updates campaign and only the selected task", async () => {
  const expected = expectedRecovery();
  const proposal = target(expected);
  const database = createDatabase();
  seed(database, expected);
  const beforeTasks = taskRows(database);
  const store = new D1ContinuationCurrentReadyStore(new SqliteBatchDatabase(database));

  assert.deepEqual(await store.persist(expected, proposal), { kind: "APPLIED" });
  assert.deepEqual({ ...campaignRow(database) }, {
    current_task_id: NEXT_TASK_ID,
    current_task_state: "READY",
    next_task_id: null,
    human_gate: null,
    expected_main_sha: MAIN_SHA,
    observed_at: READY_AT,
    updated_at: READY_AT,
  });

  const afterTasks = taskRows(database);
  assert.deepEqual(afterTasks[0], beforeTasks[0]);
  assert.deepEqual(afterTasks[2], beforeTasks[2]);
  assert.deepEqual(afterTasks[1], {
    ...beforeTasks[1],
    task_state: "READY",
    updated_at: READY_AT,
  });
  database.close();
});

test("exact replay is idempotent and does not execute a second batch", async () => {
  const expected = expectedRecovery();
  const proposal = target(expected);
  const database = createDatabase();
  seed(database, expected);
  const adapter = new SqliteBatchDatabase(database);
  const store = new D1ContinuationCurrentReadyStore(adapter);

  assert.deepEqual(await store.persist(expected, proposal), { kind: "APPLIED" });
  assert.deepEqual(await store.persist(expected, proposal), { kind: "ALREADY_APPLIED" });
  assert.equal(adapter.batchCalls, 1);
  database.close();
});

test("durable task drift is rejected by the idempotency pre-read before batch", async () => {
  const expected = expectedRecovery();
  const proposal = target(expected);
  const database = createDatabase();
  seed(database, expected);
  sqliteStatement(
    database,
    "UPDATE continuation_tasks SET task_state = 'WAITING', updated_at = ? WHERE campaign_id = ? AND task_id = ?",
  ).run(DRIFT_AT, CAMPAIGN_ID, OTHER_TASK_ID);
  const adapter = new SqliteBatchDatabase(database);

  await assert.rejects(
    new D1ContinuationCurrentReadyStore(adapter).persist(expected, proposal),
    expectCode("STALE_DURABLE_STATE"),
  );
  assert.equal(adapter.batchCalls, 0);
  assert.equal(campaignRow(database).current_task_id, COMPLETED_TASK_ID);
  database.close();
});

test("concurrent drift after pre-read aborts and rolls back the whole batch", async () => {
  const expected = expectedRecovery();
  const proposal = target(expected);
  const database = createDatabase();
  seed(database, expected);
  const adapter = new SqliteBatchDatabase(database, {
    beforeBatch: () => {
      sqliteStatement(
        database,
        "UPDATE continuation_tasks SET task_state = 'WAITING', updated_at = ? WHERE campaign_id = ? AND task_id = ?",
      ).run(DRIFT_AT, CAMPAIGN_ID, OTHER_TASK_ID);
    },
  });

  await assert.rejects(
    new D1ContinuationCurrentReadyStore(adapter).persist(expected, proposal),
    expectCode("D1_BATCH_FAILED"),
  );
  assert.equal(campaignRow(database).current_task_id, COMPLETED_TASK_ID);
  assert.equal(campaignRow(database).next_task_id, NEXT_TASK_ID);
  const drifted = taskRows(database).find((row) => row.task_id === OTHER_TASK_ID);
  assert.equal(drifted?.task_state, "WAITING");
  database.close();
});

test("non-canonical transition is rejected before any D1 batch", async () => {
  const expected = expectedRecovery();
  const proposal = target(expected);
  const malformed = {
    ...proposal,
    campaign: { ...proposal.campaign, nextTaskId: NEXT_TASK_ID },
  } as ContinuationCurrentReadyTransitionProposal;
  const database = createDatabase();
  seed(database, expected);
  const adapter = new SqliteBatchDatabase(database);

  await assert.rejects(
    new D1ContinuationCurrentReadyStore(adapter).persist(expected, malformed),
    expectCode("INVALID_TRANSITION"),
  );
  assert.equal(adapter.batchCalls, 0);
  database.close();
});

test("reported batch failure leaves the durable state unchanged", async () => {
  const expected = expectedRecovery();
  const proposal = target(expected);
  const database = createDatabase();
  seed(database, expected);
  const beforeCampaign = { ...campaignRow(database) };
  const beforeTasks = taskRows(database);

  await assert.rejects(
    new D1ContinuationCurrentReadyStore(
      new SqliteBatchDatabase(database, { failBatch: true }),
    ).persist(expected, proposal),
    expectCode("D1_BATCH_FAILED"),
  );
  assert.deepEqual({ ...campaignRow(database) }, beforeCampaign);
  assert.deepEqual(taskRows(database), beforeTasks);
  database.close();
});

test("unexpected batch change counts fail closed", async () => {
  const expected = expectedRecovery();
  const proposal = target(expected);
  const database = createDatabase();
  seed(database, expected);

  await assert.rejects(
    new D1ContinuationCurrentReadyStore(
      new SqliteBatchDatabase(database, {
        forcedResults: [
          { success: true, meta: { changes: 1 }, results: [] },
          { success: true, meta: { changes: 0 }, results: [] },
        ],
      }),
    ).persist(expected, proposal),
    expectCode("D1_CHANGE_COUNT_INVALID"),
  );
  database.close();
});

test("post-write durable drift fails verification", async () => {
  const expected = expectedRecovery();
  const proposal = target(expected);
  const database = createDatabase();
  seed(database, expected);

  await assert.rejects(
    new D1ContinuationCurrentReadyStore(
      new SqliteBatchDatabase(database, {
        afterBatch: () => {
          sqliteStatement(
            database,
            "UPDATE continuation_tasks SET task_state = 'WAITING', updated_at = ? WHERE campaign_id = ? AND task_id = ?",
          ).run(DRIFT_AT, CAMPAIGN_ID, NEXT_TASK_ID);
        },
      }),
    ).persist(expected, proposal),
    expectCode("POSTWRITE_VERIFICATION_FAILED"),
  );
  database.close();
});

test("source boundary keeps the new store detached from runtime and production wiring", () => {
  const runtimeSource = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/continuation-runtime.ts"),
    "utf8",
  );
  const workerSource = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wranglerSource = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");

  assert.doesNotMatch(runtimeSource, /D1ContinuationCurrentReadyStore/u);
  assert.doesNotMatch(runtimeSource, /CURRENT_READY_TRANSITION/u);
  assert.doesNotMatch(workerSource, /current-ready/u);
  assert.doesNotMatch(wranglerSource, /CURRENT_READY_TRANSITION/u);
  assert.doesNotMatch(wranglerSource, /CURRENT_READY_STORE/u);
});
