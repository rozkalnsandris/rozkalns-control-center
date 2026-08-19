import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";

import {
  D1NotificationTransitionStore,
  D1NotificationTransitionStoreError,
} from "../src/integrations/cloudflare/d1-notification-transition-store.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import type { DecisionReadModel } from "../src/shared/control-model.js";
import {
  notificationCandidateForDecision,
  type NotificationCandidate,
} from "../src/shared/notification-transition.js";

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
    const value = this.#results.shift();
    if (!value) throw new Error("Unexpected fake D1 execution");
    return value;
  }
}

function result(changes: number, rows: readonly Record<string, unknown>[] = []): D1RunResultLike {
  return { success: true, meta: { changes }, results: rows };
}

function decision(overrides: Partial<DecisionReadModel> = {}): DecisionReadModel {
  return {
    id: "github:hermes-deals:pr:517",
    projectId: "hermes-deals",
    workflowState: "CI_FAILED",
    issueNumber: 514,
    issueTitle: "Remove frontend archaeology",
    prNumber: 517,
    prTitle: "ui: remove W5B frontend archaeology",
    prUrl: "https://github.com/rozkalnsandris/hermes-deals/pull/517",
    ci: "FAIL",
    review: "PENDING",
    deployImpact: "UNKNOWN",
    changedFiles: 13,
    expectedHeadSha: "a".repeat(40),
    currentHeadSha: "a".repeat(40),
    mainSha: "b".repeat(40),
    reason: "Required CI failed and needs operator review",
    lastReconciledAt: "2026-08-19T18:51:00.000Z",
    allowedActions: ["OPEN_PR"],
    ...overrides,
  };
}

const candidate = notificationCandidateForDecision(decision(), "CI_FAILED");
const CLAIMED_AT = "2026-08-19T19:10:00.000Z";

function storedRow(
  overrides: Partial<{
    transition_id: string;
    schema_version: number;
    signal: string;
    decision_id: string;
    project_id: string;
    reference: string;
    title: string;
    body: string;
    deep_link_path: string;
    claimed_at: string;
  }> = {},
) {
  return {
    transition_id: candidate.transitionId,
    schema_version: candidate.schemaVersion,
    signal: candidate.signal,
    decision_id: candidate.decisionId,
    project_id: candidate.projectId,
    reference: candidate.reference,
    title: candidate.title,
    body: candidate.body,
    deep_link_path: candidate.deepLinkPath,
    claimed_at: CLAIMED_AT,
    ...overrides,
  };
}

test("first notification transition claim is one atomic bound insert with no provider fields", async () => {
  const database = new FakeD1Database([result(1)]);
  const store = new D1NotificationTransitionStore(database);

  assert.deepEqual(await store.claim({ candidate, claimedAt: CLAIMED_AT }), { kind: "CLAIMED" });
  assert.equal(database.prepared.length, 1);

  const insert = database.prepared[0];
  assert.match(insert.sql, /INSERT INTO notification_transitions/);
  assert.match(insert.sql, /ON CONFLICT\(transition_id\) DO NOTHING/);
  assert.doesNotMatch(insert.sql, /telegram|web_push|provider|access_token|secret|credential/i);
  assert.deepEqual(insert.values, [
    candidate.transitionId,
    1,
    "CI_FAILED",
    candidate.decisionId,
    candidate.projectId,
    candidate.reference,
    candidate.title,
    candidate.body,
    candidate.deepLinkPath,
    CLAIMED_AT,
  ]);
});

test("exact duplicate transition re-reads durable identity and does not require the new observation time to match", async () => {
  const database = new FakeD1Database([result(0), result(0, [storedRow()])]);
  const store = new D1NotificationTransitionStore(database);

  assert.deepEqual(
    await store.claim({ candidate, claimedAt: "2026-08-19T20:10:00.000Z" }),
    { kind: "DUPLICATE" },
  );
  assert.equal(database.prepared.length, 2);
  assert.match(database.prepared[1].sql, /WHERE transition_id = \?1/);
  assert.deepEqual(database.prepared[1].values, [candidate.transitionId]);
});

test("transition-id collision or stored candidate drift fails closed", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [storedRow({ title: "Different durable candidate" })]),
  ]);

  await assert.rejects(
    () => new D1NotificationTransitionStore(database).claim({ candidate, claimedAt: CLAIMED_AT }),
    D1NotificationTransitionStoreError,
  );
});

test("malformed or ambiguous stored transition evidence fails closed", async () => {
  const malformed = new FakeD1Database([
    result(0),
    result(0, [storedRow({ claimed_at: "not-a-time" })]),
  ]);
  await assert.rejects(
    () => new D1NotificationTransitionStore(malformed).claim({ candidate, claimedAt: CLAIMED_AT }),
    D1NotificationTransitionStoreError,
  );

  const multiple = new FakeD1Database([result(0), result(0, [storedRow(), storedRow()])]);
  await assert.rejects(
    () => new D1NotificationTransitionStore(multiple).claim({ candidate, claimedAt: CLAIMED_AT }),
    D1NotificationTransitionStoreError,
  );
});

test("candidate validation rejects unsanitized text, mismatched links and non-UTC claim times before D1", async () => {
  const unsanitizedDb = new FakeD1Database([]);
  await assert.rejects(
    () =>
      new D1NotificationTransitionStore(unsanitizedDb).claim({
        candidate: { ...candidate, title: `${candidate.title}\nunsafe` },
        claimedAt: CLAIMED_AT,
      }),
    D1NotificationTransitionStoreError,
  );
  assert.equal(unsanitizedDb.prepared.length, 0);

  const linkDb = new FakeD1Database([]);
  await assert.rejects(
    () =>
      new D1NotificationTransitionStore(linkDb).claim({
        candidate: { ...candidate, deepLinkPath: "/#decision-deadbeef" },
        claimedAt: CLAIMED_AT,
      }),
    D1NotificationTransitionStoreError,
  );
  assert.equal(linkDb.prepared.length, 0);

  const timeDb = new FakeD1Database([]);
  await assert.rejects(
    () =>
      new D1NotificationTransitionStore(timeDb).claim({
        candidate,
        claimedAt: "2026-08-19T21:10:00+02:00",
      }),
    D1NotificationTransitionStoreError,
  );
  assert.equal(timeDb.prepared.length, 0);
});

test("0003 migration creates only the bounded durable transition registry with unique transition ids", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "migrations/0003_notification_transitions.sql"),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");

  try {
    database.exec(migration);

    const columns = database.prepare("PRAGMA table_info(notification_transitions)").all() as Array<{
      name: string;
      pk: number;
    }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "transition_id",
        "schema_version",
        "signal",
        "decision_id",
        "project_id",
        "reference",
        "title",
        "body",
        "deep_link_path",
        "claimed_at",
      ],
    );
    assert.equal(columns.find((column) => column.name === "transition_id")?.pk, 1);
    assert.doesNotMatch(
      columns.map((column) => column.name).join(" "),
      /provider|telegram|web_push|token|secret|credential/i,
    );

    const insert = database.prepare(`
      INSERT INTO notification_transitions (
        transition_id, schema_version, signal, decision_id, project_id,
        reference, title, body, deep_link_path, claimed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const values = [
      candidate.transitionId,
      1,
      candidate.signal,
      candidate.decisionId,
      candidate.projectId,
      candidate.reference,
      candidate.title,
      candidate.body,
      candidate.deepLinkPath,
      CLAIMED_AT,
    ] as const;

    insert.run(...values);
    assert.throws(() => insert.run(...values));
    assert.throws(() =>
      insert.run(
        "notification-v1-ci-failed-0000000000000001",
        1,
        "OTHER",
        candidate.decisionId,
        candidate.projectId,
        candidate.reference,
        candidate.title,
        candidate.body,
        candidate.deepLinkPath,
        CLAIMED_AT,
      ),
    );
  } finally {
    database.close();
  }
});

test("durable notification store remains detached from Worker and React runtime", () => {
  const workerSource = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const reactSource = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
  const runtimePattern = /notification-transition-store|D1NotificationTransitionStore|notification_transitions/;

  assert.doesNotMatch(workerSource, runtimePattern);
  assert.doesNotMatch(reactSource, runtimePattern);
});
