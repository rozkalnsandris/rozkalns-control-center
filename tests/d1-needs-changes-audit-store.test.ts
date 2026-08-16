import assert from "node:assert/strict";
import test from "node:test";

import {
  D1NeedsChangesAuditError,
  D1NeedsChangesDecisionAuditStore,
} from "../src/integrations/cloudflare/d1-needs-changes-audit-store.js";
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

const REQUEST_ID = "request-123456789";
const FINGERPRINT = "a".repeat(64);
const HEAD_SHA = "b".repeat(40);
const MAIN_SHA = "c".repeat(40);
const OBSERVED_AT = "2026-08-16T14:30:00.000Z";
const SUBMITTED_AT = "2026-08-16T14:30:02.000Z";
const COMPLETED_AT = "2026-08-16T14:30:03.000Z";

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
  expectedHeadSha: HEAD_SHA,
  expectedMainSha: MAIN_SHA,
  requestedAt: "2026-08-16T14:29:59.000Z",
};

const successResult = {
  status: "CHANGES_REQUESTED" as const,
  requestId: REQUEST_ID,
  actor: claim.actor,
  repository: claim.repository,
  issueNumber: claim.issueNumber,
  pullNumber: claim.pullNumber,
  expectedHeadSha: HEAD_SHA,
  observedHeadSha: HEAD_SHA,
  expectedMainSha: MAIN_SHA,
  observedMainSha: MAIN_SHA,
  observedAt: OBSERVED_AT,
  reviewId: "42",
  reviewUrl: "https://github.com/rozkalnsandris/hermes-deals/pull/701#pullrequestreview-42",
  submittedAt: SUBMITTED_AT,
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
    expected_head_sha: HEAD_SHA,
    expected_main_sha: MAIN_SHA,
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
}

function store(database: FakeD1Database) {
  return new D1NeedsChangesDecisionAuditStore(database, () => new Date(COMPLETED_AT));
}

test("D1 Needs changes claim is one bound atomic insert and persists no review body or credential material", async () => {
  const database = new FakeD1Database([result(1)]);
  assert.deepEqual(await store(database).claim(claim), { kind: "CLAIMED" });

  assert.equal(database.prepared.length, 1);
  const insert = database.prepared[0];
  assert.match(insert.sql, /INSERT INTO needs_changes_decisions/);
  assert.match(insert.sql, /ON CONFLICT\(request_id\) DO NOTHING/);
  assert.match(insert.sql, /'IN_PROGRESS'/);
  assert.doesNotMatch(insert.sql, /review_body|access_jwt|token|secret|private_key/i);
  assert.deepEqual(insert.values, [
    REQUEST_ID,
    FINGERPRINT,
    "access-user-123",
    "andris@example.invalid",
    "rozkalnsandris/hermes-deals",
    "hermes-deals",
    700,
    701,
    HEAD_SHA,
    MAIN_SHA,
    "2026-08-16T14:29:59.000Z",
  ]);
});

test("same request and fingerprint returns IN_PROGRESS without creating a second claim", async () => {
  const database = new FakeD1Database([result(0), result(0, [storedRow()])]);
  const replayedAtLaterTime = { ...claim, requestedAt: "2026-08-16T15:00:00.000Z" };

  assert.deepEqual(await store(database).claim(replayedAtLaterTime), { kind: "IN_PROGRESS" });
  assert.equal(database.prepared.length, 2);
  assert.match(database.prepared[1].sql, /WHERE request_id = \?1/);
  assert.deepEqual(database.prepared[1].values, [REQUEST_ID]);
});

test("same request id with a different fingerprint returns CONFLICT", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [storedRow({ fingerprint: "d".repeat(64) })]),
  ]);

  assert.deepEqual(await store(database).claim(claim), { kind: "CONFLICT" });
});

test("matching terminal success is reconstructed as an exact replay", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [
      storedRow({
        state: "SUCCEEDED",
        observed_head_sha: HEAD_SHA,
        observed_main_sha: MAIN_SHA,
        observed_at: OBSERVED_AT,
        review_id: "42",
        review_url: successResult.reviewUrl,
        submitted_at: SUBMITTED_AT,
        completed_at: COMPLETED_AT,
      }),
    ]),
  ]);

  assert.deepEqual(await store(database).claim(claim), {
    kind: "REPLAY",
    outcome: { kind: "SUCCEEDED", result: successResult },
  });
});

test("matching FAILED and UNKNOWN rows replay stable terminal outcomes", async () => {
  const failedDb = new FakeD1Database([
    result(0),
    result(0, [
      storedRow({
        state: "FAILED",
        outcome_code: "AUTHORIZATION_STALE_HEAD",
        completed_at: COMPLETED_AT,
      }),
    ]),
  ]);
  assert.deepEqual(await store(failedDb).claim(claim), {
    kind: "REPLAY",
    outcome: { kind: "FAILED", code: "AUTHORIZATION_STALE_HEAD" },
  });

  const unknownDb = new FakeD1Database([
    result(0),
    result(0, [
      storedRow({
        state: "UNKNOWN",
        outcome_code: "WRITE_OUTCOME_UNKNOWN",
        completed_at: COMPLETED_AT,
      }),
    ]),
  ]);
  assert.deepEqual(await store(unknownDb).claim(claim), {
    kind: "REPLAY",
    outcome: { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN" },
  });
});

test("duplicate identity corruption fails closed even when fingerprint matches", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [storedRow({ pull_number: 999 })]),
  ]);
  await assert.rejects(() => store(database).claim(claim), D1NeedsChangesAuditError);
});

test("malformed or ambiguous durable rows fail closed", async () => {
  const unsupportedState = new FakeD1Database([
    result(0),
    result(0, [storedRow({ state: "OTHER" })]),
  ]);
  await assert.rejects(() => store(unsupportedState).claim(claim), D1NeedsChangesAuditError);

  const badSuccess = new FakeD1Database([
    result(0),
    result(0, [storedRow({ state: "SUCCEEDED", completed_at: COMPLETED_AT })]),
  ]);
  await assert.rejects(() => store(badSuccess).claim(claim), D1NeedsChangesAuditError);

  const multiple = new FakeD1Database([
    result(0),
    result(0, [storedRow(), storedRow()]),
  ]);
  await assert.rejects(() => store(multiple).claim(claim), D1NeedsChangesAuditError);
});

test("success completion is conditional on exact fingerprinted identity and stores bounded review evidence", async () => {
  const database = new FakeD1Database([result(1)]);
  await store(database).complete(REQUEST_ID, FINGERPRINT, {
    kind: "SUCCEEDED",
    result: successResult,
  });

  assert.equal(database.prepared.length, 1);
  const update = database.prepared[0];
  assert.match(update.sql, /state = 'SUCCEEDED'/);
  assert.match(update.sql, /AND fingerprint = \?2/);
  assert.match(update.sql, /AND state = 'IN_PROGRESS'/);
  assert.match(update.sql, /actor_email IS \?4/);
  assert.doesNotMatch(update.sql, /review_body|access_jwt|token|secret|private_key/i);
  assert.deepEqual(update.values, [
    REQUEST_ID,
    FINGERPRINT,
    "access-user-123",
    "andris@example.invalid",
    "rozkalnsandris/hermes-deals",
    "hermes-deals",
    700,
    701,
    HEAD_SHA,
    MAIN_SHA,
    HEAD_SHA,
    MAIN_SHA,
    OBSERVED_AT,
    "42",
    successResult.reviewUrl,
    SUBMITTED_AT,
    COMPLETED_AT,
  ]);
});

test("failed and unknown completion use exact one-way IN_PROGRESS transitions", async () => {
  const failedDb = new FakeD1Database([result(1)]);
  await store(failedDb).complete(REQUEST_ID, FINGERPRINT, {
    kind: "FAILED",
    code: "DECISION_NOT_READY",
  });
  assert.match(failedDb.prepared[0].sql, /state = 'FAILED'/);
  assert.match(failedDb.prepared[0].sql, /AND state = 'IN_PROGRESS'/);
  assert.deepEqual(failedDb.prepared[0].values, [
    REQUEST_ID,
    FINGERPRINT,
    "DECISION_NOT_READY",
    COMPLETED_AT,
  ]);

  const unknownDb = new FakeD1Database([result(1)]);
  await store(unknownDb).complete(REQUEST_ID, FINGERPRINT, {
    kind: "UNKNOWN",
    code: "WRITE_OUTCOME_UNKNOWN",
  });
  assert.match(unknownDb.prepared[0].sql, /state = 'UNKNOWN'/);
  assert.match(unknownDb.prepared[0].sql, /WRITE_OUTCOME_UNKNOWN/);
  assert.match(unknownDb.prepared[0].sql, /AND state = 'IN_PROGRESS'/);
  assert.deepEqual(unknownDb.prepared[0].values, [REQUEST_ID, FINGERPRINT, COMPLETED_AT]);
});

test("completion refuses unsupported failure codes, mismatched success request ids and repeated terminal updates", async () => {
  const unsupported = new FakeD1Database([]);
  await assert.rejects(
    () => store(unsupported).complete(REQUEST_ID, FINGERPRINT, {
      kind: "FAILED",
      code: "AUDIT_FINALIZATION_FAILED",
    }),
    D1NeedsChangesAuditError,
  );

  const mismatch = new FakeD1Database([]);
  await assert.rejects(
    () => store(mismatch).complete(REQUEST_ID, FINGERPRINT, {
      kind: "SUCCEEDED",
      result: { ...successResult, requestId: "request-987654321" },
    }),
    D1NeedsChangesAuditError,
  );

  const alreadyTerminal = new FakeD1Database([result(0)]);
  await assert.rejects(
    () => store(alreadyTerminal).complete(REQUEST_ID, FINGERPRINT, {
      kind: "UNKNOWN",
      code: "WRITE_OUTCOME_UNKNOWN",
    }),
    D1NeedsChangesAuditError,
  );
});

test("claim validation rejects unmanaged repositories, malformed fingerprints and non-UTC timestamps before D1", async () => {
  const unmanaged = new FakeD1Database([]);
  await assert.rejects(
    () => store(unmanaged).claim({ ...claim, repository: "rozkalnsandris/hermes-email-skill" }),
  );

  const fingerprint = new FakeD1Database([]);
  await assert.rejects(
    () => store(fingerprint).claim({ ...claim, fingerprint: "not-a-fingerprint" }),
    D1NeedsChangesAuditError,
  );

  const time = new FakeD1Database([]);
  await assert.rejects(
    () => store(time).claim({ ...claim, requestedAt: "2026-08-16T16:30:00+02:00" }),
    D1NeedsChangesAuditError,
  );
});
