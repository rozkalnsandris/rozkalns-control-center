import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  D1ContinuationNextTaskStore,
  D1ContinuationNextTaskStoreError,
} from "../src/integrations/cloudflare/d1-continuation-next-task-store.js";
import {
  planContinuationNextTaskTransition,
  type ContinuationNextTaskTransitionProposal,
} from "../src/integrations/cloudflare/continuation-next-task-transition.js";
import type { ContinuationPostMergeTransitionProposal } from "../src/integrations/cloudflare/continuation-post-merge-transition.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const MERGED_TASK_ID = "task:517";
const NEXT_TASK_ID = "task:518";
const OTHER_TASK_ID = "task:519";
const PREVIOUS_MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const MERGE_SHA = "1111111111111111111111111111111111111111";
const EXPECTED_HEAD_SHA = "3333333333333333333333333333333333333333";
const TRANSITION_AT = "2026-08-21T16:20:40.000Z";
const READY_AT = "2026-08-21T16:21:00.000Z";
const DRIFT_AT = "2026-08-21T16:22:00.000Z";

interface SqliteStatementLike {
  all(...values: unknown[]): unknown[];
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes: number | bigint };
}

interface SqliteD1Options {
  readonly failUpdate?: boolean;
  readonly forcedUpdateChanges?: number;
  readonly afterUpdate?: (() => void) | null;
}

function sqliteBindings(query: string, values: readonly unknown[]): readonly unknown[] {
  if (!/\?[1-9]\d*/u.test(query)) return values;
  return [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))];
}

class SqliteD1PreparedStatement implements D1PreparedStatementLike {
  readonly #database: DatabaseSync;
  readonly #query: string;
  readonly #options: SqliteD1Options;
  readonly #values: readonly unknown[];

  constructor(
    database: DatabaseSync,
    query: string,
    options: SqliteD1Options,
    values: readonly unknown[] = [],
  ) {
    this.#database = database;
    this.#query = query;
    this.#options = options;
    this.#values = values;
  }

  bind(...values: readonly unknown[]): D1PreparedStatementLike {
    return new SqliteD1PreparedStatement(this.#database, this.#query, this.#options, values);
  }

  async run<Row = Record<string, unknown>>(): Promise<D1RunResultLike<Row>> {
    const isSelect = /^\s*SELECT\b/i.test(this.#query);
    const isCampaignUpdate = /^\s*UPDATE\s+continuation_campaigns\b/i.test(this.#query);

    if (isCampaignUpdate && this.#options.failUpdate === true) {
      return { success: false, meta: { changes: 0 }, results: [] };
    }
    if (isCampaignUpdate && this.#options.forcedUpdateChanges !== undefined) {
      return {
        success: true,
        meta: { changes: this.#options.forcedUpdateChanges },
        results: [],
      };
    }

    const statement = this.#database.prepare(this.#query) as unknown as SqliteStatementLike;
    const boundValues = sqliteBindings(this.#query, this.#values);
    if (isSelect) {
      return {
        success: true,
        meta: { changes: 0 },
        results: statement.all(...boundValues) as Row[],
      };
    }

    const result = statement.run(...boundValues);
    if (isCampaignUpdate) this.#options.afterUpdate?.();
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    };
  }
}

class SqliteD1Database implements D1DatabaseLike {
  readonly #database: DatabaseSync;
  readonly #options: SqliteD1Options;

  constructor(database: DatabaseSync, options: SqliteD1Options = {}) {
    this.#database = database;
    this.#options = options;
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqliteD1PreparedStatement(this.#database, query, this.#options);
  }
}

function sqliteStatement(database: DatabaseSync, sql: string): SqliteStatementLike {
  return database.prepare(sql) as unknown as SqliteStatementLike;
}

function transition(): ContinuationPostMergeTransitionProposal {
  return {
    schemaVersion: 1,
    kind: "POST_MERGE_TRANSITION",
    mergeEvidence: {
      merged: true,
      taskId: MERGED_TASK_ID,
      issueNumber: 517,
      pullRequestNumber: 600,
      expectedHeadSha: EXPECTED_HEAD_SHA,
      previousMainSha: PREVIOUS_MAIN_SHA,
      mergeSha: MERGE_SHA,
      observedAt: TRANSITION_AT,
    },
    campaign: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      scope: "lidl",
      mode: "CONTINUE_ISSUES",
      continueEnabled: true,
      paused: false,
      expectedMainSha: MERGE_SHA,
      currentTask: { taskId: MERGED_TASK_ID, state: "DONE" },
      nextTaskId: null,
      humanGate: null,
      observedAt: TRANSITION_AT,
      updatedAt: TRANSITION_AT,
    },
    tasks: [
      {
        taskId: MERGED_TASK_ID,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: 517,
        taskState: "DONE",
        activePullRequestNumber: null,
        expectedHeadSha: null,
        priority: 10,
        updatedAt: TRANSITION_AT,
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
        updatedAt: "2026-08-21T16:19:00.000Z",
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
        updatedAt: "2026-08-21T16:18:00.000Z",
      },
    ],
  };
}

function proposal(expected: ContinuationPostMergeTransitionProposal): ContinuationNextTaskTransitionProposal {
  return planContinuationNextTaskTransition(expected, {
    kind: "READY",
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: NEXT_TASK_ID,
    issueNumber: 518,
    expectedMainSha: MERGE_SHA,
    observedAt: READY_AT,
  });
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(
    readFileSync(resolve(process.cwd(), "migrations/0007_continuation_campaigns.sql"), "utf8"),
  );
  return database;
}

function seed(database: DatabaseSync, expected: ContinuationPostMergeTransitionProposal): void {
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
    `SELECT next_task_id, observed_at, updated_at, expected_main_sha,
            current_task_id, current_task_state, human_gate
     FROM continuation_campaigns WHERE campaign_id = ?`,
  ).get(CAMPAIGN_ID) as Record<string, unknown>;
}

function taskRows(database: DatabaseSync): readonly Record<string, unknown>[] {
  return sqliteStatement(
    database,
    `SELECT task_id, issue_number, task_state, active_pull_request_number,
            expected_head_sha, priority, updated_at
     FROM continuation_tasks
     WHERE campaign_id = ?
     ORDER BY priority ASC, issue_number ASC`,
  ).all(CAMPAIGN_ID) as Record<string, unknown>[];
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof D1ContinuationNextTaskStoreError && error.code === code;
}

test("exact next-task proposal is applied with one campaign-only CAS write", async () => {
  const expected = transition();
  const target = proposal(expected);
  const database = createDatabase();
  seed(database, expected);
  const beforeTasks = taskRows(database);

  const result = await new D1ContinuationNextTaskStore(new SqliteD1Database(database)).persist(
    expected,
    target,
  );

  assert.deepEqual(result, { kind: "APPLIED" });
  assert.deepEqual({ ...campaignRow(database) }, {
    next_task_id: NEXT_TASK_ID,
    observed_at: READY_AT,
    updated_at: READY_AT,
    expected_main_sha: MERGE_SHA,
    current_task_id: MERGED_TASK_ID,
    current_task_state: "DONE",
    human_gate: null,
  });
  assert.deepEqual(taskRows(database), beforeTasks);
  database.close();
});

test("exact replay is idempotent and returns ALREADY_APPLIED", async () => {
  const expected = transition();
  const target = proposal(expected);
  const database = createDatabase();
  seed(database, expected);
  const store = new D1ContinuationNextTaskStore(new SqliteD1Database(database));

  assert.deepEqual(await store.persist(expected, target), { kind: "APPLIED" });
  const afterFirst = campaignRow(database);
  assert.deepEqual(await store.persist(expected, target), { kind: "ALREADY_APPLIED" });
  assert.deepEqual(campaignRow(database), afterFirst);
  database.close();
});

test("campaign timestamp drift fails closed before reservation", async () => {
  const expected = transition();
  const target = proposal(expected);
  const database = createDatabase();
  seed(database, expected);
  sqliteStatement(
    database,
    "UPDATE continuation_campaigns SET observed_at = ?, updated_at = ? WHERE campaign_id = ?",
  ).run(DRIFT_AT, DRIFT_AT, CAMPAIGN_ID);

  await assert.rejects(
    new D1ContinuationNextTaskStore(new SqliteD1Database(database)).persist(expected, target),
    expectCode("STALE_DURABLE_STATE"),
  );
  assert.equal(campaignRow(database).next_task_id, null);
  database.close();
});

test("any existing task drift blocks the campaign CAS", async () => {
  const expected = transition();
  const target = proposal(expected);
  const database = createDatabase();
  seed(database, expected);
  sqliteStatement(
    database,
    "UPDATE continuation_tasks SET task_state = 'WAITING' WHERE campaign_id = ? AND task_id = ?",
  ).run(CAMPAIGN_ID, OTHER_TASK_ID);

  await assert.rejects(
    new D1ContinuationNextTaskStore(new SqliteD1Database(database)).persist(expected, target),
    expectCode("STALE_DURABLE_STATE"),
  );
  assert.equal(campaignRow(database).next_task_id, null);
  database.close();
});

test("an extra durable task blocks the complete-task-set CAS", async () => {
  const expected = transition();
  const target = proposal(expected);
  const database = createDatabase();
  seed(database, expected);
  sqliteStatement(
    database,
    `INSERT INTO continuation_tasks (
      campaign_id, task_id, project_id, repository, issue_number, task_state,
      active_pull_request_number, expected_head_sha, priority, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    CAMPAIGN_ID,
    "task:520",
    PROJECT_ID,
    REPOSITORY,
    520,
    "DISCOVERED",
    null,
    null,
    40,
    "2026-08-21T16:17:00.000Z",
  );

  await assert.rejects(
    new D1ContinuationNextTaskStore(new SqliteD1Database(database)).persist(expected, target),
    expectCode("STALE_DURABLE_STATE"),
  );
  assert.equal(campaignRow(database).next_task_id, null);
  database.close();
});

test("non-canonical proposal is rejected before any D1 mutation", async () => {
  const expected = transition();
  const target = proposal(expected);
  const malformed = {
    ...target,
    campaign: { ...target.campaign, nextTaskId: OTHER_TASK_ID },
  } as ContinuationNextTaskTransitionProposal;
  const database = createDatabase();
  seed(database, expected);

  await assert.rejects(
    new D1ContinuationNextTaskStore(new SqliteD1Database(database)).persist(expected, malformed),
    expectCode("INVALID_TRANSITION"),
  );
  assert.equal(campaignRow(database).next_task_id, null);
  database.close();
});

test("reported D1 write failure fails closed without reservation", async () => {
  const expected = transition();
  const target = proposal(expected);
  const database = createDatabase();
  seed(database, expected);

  await assert.rejects(
    new D1ContinuationNextTaskStore(
      new SqliteD1Database(database, { failUpdate: true }),
    ).persist(expected, target),
    expectCode("D1_WRITE_FAILED"),
  );
  assert.equal(campaignRow(database).next_task_id, null);
  database.close();
});

test("unexpected D1 change count is rejected", async () => {
  const expected = transition();
  const target = proposal(expected);
  const database = createDatabase();
  seed(database, expected);

  await assert.rejects(
    new D1ContinuationNextTaskStore(
      new SqliteD1Database(database, { forcedUpdateChanges: 2 }),
    ).persist(expected, target),
    expectCode("D1_CHANGE_COUNT_INVALID"),
  );
  assert.equal(campaignRow(database).next_task_id, null);
  database.close();
});

test("postwrite durable drift fails verification and never becomes retry permission", async () => {
  const expected = transition();
  const target = proposal(expected);
  const database = createDatabase();
  seed(database, expected);
  const adapter = new SqliteD1Database(database, {
    afterUpdate: () => {
      sqliteStatement(
        database,
        "UPDATE continuation_tasks SET task_state = 'WAITING' WHERE campaign_id = ? AND task_id = ?",
      ).run(CAMPAIGN_ID, NEXT_TASK_ID);
    },
  });

  await assert.rejects(
    new D1ContinuationNextTaskStore(adapter).persist(expected, target),
    expectCode("POSTWRITE_VERIFICATION_FAILED"),
  );
  assert.equal(campaignRow(database).next_task_id, NEXT_TASK_ID);
  database.close();
});

test("source boundary stays detached from Worker/runtime configuration", () => {
  const workerSource = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wrangler = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");

  assert.doesNotMatch(workerSource, /d1-continuation-next-task-store/);
  assert.doesNotMatch(wrangler, /continuation_campaigns|continuation_tasks/);
});