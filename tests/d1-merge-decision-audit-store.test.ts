import assert from "node:assert/strict";
import test from "node:test";

import {
  D1MergeDecisionAuditError,
  D1MergeDecisionAuditStore,
} from "../src/integrations/cloudflare/d1-merge-decision-audit-store.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

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

const REQUEST_ID = "merge-request-12345";
const FINGERPRINT = "a".repeat(64);
const HEAD_SHA = "b".repeat(40);
const MAIN_SHA = "c".repeat(40);
const MERGE_SHA = "d".repeat(40);
const OBSERVED_AT = "2026-08-24T13:10:00.000Z";
const COMPLETED_AT = "2026-08-24T13:10:02.000Z";

const claim = {
  requestId: REQUEST_ID,
  fingerprint: FINGERPRINT,
  actor: {
    subject: "access-user-123",
    email: "andris@example.invalid",
  },
  repository: "rozkalnsandris/hermes-deals",
  issueNumber: 700,
  pullNumber: 701,
  mergeMethod: "merge" as const,
  expectedHeadSha: HEAD_SHA,
  expectedMainSha: MAIN_SHA,
  requestedAt: "2026-08-24T13:09:59.000Z",
};

const successResult = {
  status: "MERGED" as const,
  requestId: REQUEST_ID,
  actor: claim.actor,
  repository: claim.repository,
  issueNumber: claim.issueNumber,
  pullNumber: claim.pullNumber,
  mergeMethod: claim.mergeMethod,
  expectedHeadSha: HEAD_SHA,
  observedHeadSha: HEAD_SHA,
  expectedMainSha: MAIN_SHA,
  observedMainSha: MAIN_SHA,
  observedAt: OBSERVED_AT,
  mergeSha: MERGE_SHA,
};

function result(changes: number, rows: readonly Record<string, unknown>[] = []): D1RunResultLike {
  return { success: true, meta: { changes }, results: rows };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    fingerprint: FINGERPRINT,
    actor_subject: "access-user-123",
    actor_email: "andris@example.invalid",
    repository: "rozkalnsandris/hermes-deals",
    project_id: "hermes-deals",
    issue_number: 700,
    pull_number: 701,
    merge_method: "merge",
    expected_head_sha: HEAD_SHA,
    expected_main_sha: MAIN_SHA,
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
}

function store(database: FakeD1Database) {
  return new D1MergeDecisionAuditStore(database, () => new Date(COMPLETED_AT));
}

test("D1 Merge claim is one bound atomic insert and stores no credential or request payload material", async () => {
  const database = new FakeD1Database([result(1)]);
  assert.deepEqual(await store(database).claim(claim), { kind: "CLAIMED" });

  assert.equal(database.prepared.length, 1);
  const insert = database.prepared[0];
  assert.match(insert.sql, /INSERT INTO merge_decisions/);
  assert.match(insert.sql, /ON CONFLICT\(request_id\) DO NOTHING/);
  assert.match(insert.sql, /merge_method/);
  assert.doesNotMatch(insert.sql, /access_jwt|github_token|token|secret|private_key|request_body/i);
  assert.deepEqual(insert.values, [
    REQUEST_ID,
    FINGERPRINT,
    "access-user-123",
    "andris@example.invalid",
    "rozkalnsandris/hermes-deals",
    "hermes-deals",
    700,
    701,
    "merge",
    HEAD_SHA,
    MAIN_SHA,
    "2026-08-24T13:09:59.000Z",
  ]);
});

test("matching duplicate returns IN_PROGRESS and different fingerprint returns CONFLICT", async () => {
  const inProgress = new FakeD1Database([result(0), result(0, [storedRow()])]);
  assert.deepEqual(
    await store(inProgress).claim({ ...claim, requestedAt: "2026-08-24T13:30:00.000Z" }),
    { kind: "IN_PROGRESS" },
  );

  const conflict = new FakeD1Database([
    result(0),
    result(0, [storedRow({ fingerprint: "e".repeat(64) })]),
  ]);
  assert.deepEqual(await store(conflict).claim(claim), { kind: "CONFLICT" });
});

test("matching terminal success reconstructs the exact Merge replay", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [
      storedRow({
        state: "SUCCEEDED",
        mutation_attempted: 1,
        observed_head_sha: HEAD_SHA,
        observed_main_sha: MAIN_SHA,
        observed_at: OBSERVED_AT,
        merge_sha: MERGE_SHA,
        completed_at: COMPLETED_AT,
      }),
    ]),
  ]);

  assert.deepEqual(await store(database).claim(claim), {
    kind: "REPLAY",
    outcome: { kind: "SUCCEEDED", result: successResult },
  });
});

test("FAILED replay preserves mutationAttempted and UNKNOWN replay is always mutation-attempted", async () => {
  for (const mutationAttempted of [false, true]) {
    const database = new FakeD1Database([
      result(0),
      result(0, [
        storedRow({
          state: "FAILED",
          outcome_code: "AUTHORIZATION_STALE_HEAD",
          mutation_attempted: mutationAttempted ? 1 : 0,
          completed_at: COMPLETED_AT,
        }),
      ]),
    ]);
    assert.deepEqual(await store(database).claim(claim), {
      kind: "REPLAY",
      outcome: { kind: "FAILED", code: "AUTHORIZATION_STALE_HEAD", mutationAttempted },
    });
  }

  const unknown = new FakeD1Database([
    result(0),
    result(0, [
      storedRow({
        state: "UNKNOWN",
        outcome_code: "WRITE_OUTCOME_UNKNOWN",
        mutation_attempted: 1,
        completed_at: COMPLETED_AT,
      }),
    ]),
  ]);
  assert.deepEqual(await store(unknown).claim(claim), {
    kind: "REPLAY",
    outcome: { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN", mutationAttempted: true },
  });
});

test("duplicate identity corruption and malformed durable rows fail closed", async () => {
  const wrongMethod = new FakeD1Database([
    result(0),
    result(0, [storedRow({ merge_method: "squash" })]),
  ]);
  await assert.rejects(() => store(wrongMethod).claim(claim), D1MergeDecisionAuditError);

  const badSuccess = new FakeD1Database([
    result(0),
    result(0, [
      storedRow({
        state: "SUCCEEDED",
        mutation_attempted: 1,
        observed_head_sha: "f".repeat(40),
        observed_main_sha: MAIN_SHA,
        observed_at: OBSERVED_AT,
        merge_sha: MERGE_SHA,
        completed_at: COMPLETED_AT,
      }),
    ]),
  ]);
  await assert.rejects(() => store(badSuccess).claim(claim), D1MergeDecisionAuditError);

  const badUnknown = new FakeD1Database([
    result(0),
    result(0, [
      storedRow({
        state: "UNKNOWN",
        outcome_code: "WRITE_OUTCOME_UNKNOWN",
        mutation_attempted: 0,
        completed_at: COMPLETED_AT,
      }),
    ]),
  ]);
  await assert.rejects(() => store(badUnknown).claim(claim), D1MergeDecisionAuditError);

  const multiple = new FakeD1Database([result(0), result(0, [storedRow(), storedRow()])]);
  await assert.rejects(() => store(multiple).claim(claim), D1MergeDecisionAuditError);
});

test("success completion is conditional on exact fingerprinted identity and persists bounded Merge evidence", async () => {
  const database = new FakeD1Database([result(1)]);
  await store(database).complete(REQUEST_ID, FINGERPRINT, {
    kind: "SUCCEEDED",
    result: successResult,
  });

  const update = database.prepared[0];
  assert.match(update.sql, /state = 'SUCCEEDED'/);
  assert.match(update.sql, /mutation_attempted = 1/);
  assert.match(update.sql, /AND fingerprint = \?2/);
  assert.match(update.sql, /AND merge_method = \?9/);
  assert.match(update.sql, /AND state = 'IN_PROGRESS'/);
  assert.doesNotMatch(update.sql, /access_jwt|github_token|token|secret|private_key/i);
  assert.deepEqual(update.values, [
    REQUEST_ID,
    FINGERPRINT,
    "access-user-123",
    "andris@example.invalid",
    "rozkalnsandris/hermes-deals",
    "hermes-deals",
    700,
    701,
    "merge",
    HEAD_SHA,
    MAIN_SHA,
    HEAD_SHA,
    MAIN_SHA,
    OBSERVED_AT,
    MERGE_SHA,
    COMPLETED_AT,
  ]);
});

test("FAILED and UNKNOWN completion preserve one-way mutation evidence", async () => {
  const prewrite = new FakeD1Database([result(1)]);
  await store(prewrite).complete(REQUEST_ID, FINGERPRINT, {
    kind: "FAILED",
    code: "DECISION_NOT_READY",
    mutationAttempted: false,
  });
  assert.match(prewrite.prepared[0].sql, /state = 'FAILED'/);
  assert.deepEqual(prewrite.prepared[0].values, [
    REQUEST_ID,
    FINGERPRINT,
    "DECISION_NOT_READY",
    0,
    COMPLETED_AT,
  ]);

  const postwrite = new FakeD1Database([result(1)]);
  await store(postwrite).complete(REQUEST_ID, FINGERPRINT, {
    kind: "FAILED",
    code: "WRITE_REJECTED",
    mutationAttempted: true,
  });
  assert.deepEqual(postwrite.prepared[0].values, [
    REQUEST_ID,
    FINGERPRINT,
    "WRITE_REJECTED",
    1,
    COMPLETED_AT,
  ]);

  const unknown = new FakeD1Database([result(1)]);
  await store(unknown).complete(REQUEST_ID, FINGERPRINT, {
    kind: "UNKNOWN",
    code: "WRITE_OUTCOME_UNKNOWN",
    mutationAttempted: true,
  });
  assert.match(unknown.prepared[0].sql, /state = 'UNKNOWN'/);
  assert.match(unknown.prepared[0].sql, /mutation_attempted = 1/);
  assert.deepEqual(unknown.prepared[0].values, [REQUEST_ID, FINGERPRINT, COMPLETED_AT]);
});

test("completion refuses unsupported failure codes, mismatched success evidence and terminal overwrite", async () => {
  const unsupported = new FakeD1Database([]);
  await assert.rejects(
    () => store(unsupported).complete(REQUEST_ID, FINGERPRINT, {
      kind: "FAILED",
      code: "AUDIT_FINALIZATION_FAILED",
      mutationAttempted: true,
    }),
    D1MergeDecisionAuditError,
  );

  const mismatch = new FakeD1Database([]);
  await assert.rejects(
    () => store(mismatch).complete(REQUEST_ID, FINGERPRINT, {
      kind: "SUCCEEDED",
      result: { ...successResult, observedMainSha: "f".repeat(40) },
    }),
    D1MergeDecisionAuditError,
  );

  const terminal = new FakeD1Database([result(0)]);
  await assert.rejects(
    () => store(terminal).complete(REQUEST_ID, FINGERPRINT, {
      kind: "UNKNOWN",
      code: "WRITE_OUTCOME_UNKNOWN",
      mutationAttempted: true,
    }),
    D1MergeDecisionAuditError,
  );
});

test("claim validation rejects unmanaged repositories, malformed merge methods and non-UTC timestamps before D1", async () => {
  const unmanaged = new FakeD1Database([]);
  await assert.rejects(() => store(unmanaged).claim({ ...claim, repository: "rozkalnsandris/hermes-email-skill" }));

  const method = new FakeD1Database([]);
  await assert.rejects(
    () => store(method).claim({ ...claim, mergeMethod: "octopus" as "merge" }),
    D1MergeDecisionAuditError,
  );

  const time = new FakeD1Database([]);
  await assert.rejects(
    () => store(time).claim({ ...claim, requestedAt: "2026-08-24T15:09:59+02:00" }),
    D1MergeDecisionAuditError,
  );
});
