import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { LaterDeferralEvidence } from "../src/shared/later-decision.js";
import type { LaterDeferralClaimInput } from "../src/shared/later-deferral-store.js";
import {
  D1LaterDeferralStore,
  D1LaterDeferralStoreError,
} from "../src/integrations/cloudflare/d1-later-deferral-store.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

type SqliteValue = string | number | bigint | null | Uint8Array;

function sqliteValues(values: readonly unknown[]): SqliteValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error("test D1 adapter received an unsupported SQLite value");
  });
}

class SqliteD1Statement implements D1PreparedStatementLike {
  readonly #database: DatabaseSync;
  readonly #query: string;
  #values: readonly unknown[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.#database = database;
    this.#query = query;
  }

  bind(...values: readonly unknown[]): D1PreparedStatementLike {
    this.#values = values;
    return this;
  }

  async run<Row = Record<string, unknown>>(): Promise<D1RunResultLike<Row>> {
    const statement = this.#database.prepare(this.#query);
    const values = sqliteValues(this.#values);

    if (/^SELECT\b/i.test(this.#query.trim())) {
      return {
        success: true,
        meta: { changes: 0 },
        results: statement.all(...values) as Row[],
      };
    }

    const result = statement.run(...values);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    };
  }
}

class SqliteD1Database implements D1DatabaseLike {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqliteD1Statement(this.database, query);
  }
}

async function testDatabase(): Promise<{ database: DatabaseSync; store: D1LaterDeferralStore }> {
  const migration = await readFile("migrations/0009_later_deferrals.sql", "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  return { database, store: new D1LaterDeferralStore(new SqliteD1Database(database)) };
}

function evidence(
  fingerprint = `later-v1-${"a".repeat(16)}`,
  deferredAt = "2026-08-28T07:45:00.000Z",
): LaterDeferralEvidence {
  return {
    schemaVersion: 1,
    decisionId: "decision-hermes-deals-783",
    projectId: "hermes-deals",
    issueNumber: 782,
    prNumber: 783,
    stateFingerprint: fingerprint,
    deferredAt,
  };
}

function claim(
  currentEvidence: LaterDeferralEvidence = evidence(),
  subject = "access-user-123",
): LaterDeferralClaimInput {
  return {
    actor: { subject, email: "andris@example.invalid" },
    evidence: currentEvidence,
  };
}

test("Later D1 claim creates one row and exact material replay preserves original evidence", async () => {
  const { database, store } = await testDatabase();
  try {
    assert.deepEqual(await store.claim(claim()), { kind: "CLAIMED" });

    const replayEvidence = evidence(
      `later-v1-${"a".repeat(16)}`,
      "2026-08-28T07:46:00.000Z",
    );
    assert.deepEqual(await store.claim(claim(replayEvidence)), { kind: "REPLAY" });

    const stored = await store.read("decision-hermes-deals-783");
    assert.equal(stored?.deferredAt, "2026-08-28T07:45:00.000Z");
    assert.equal(stored?.stateFingerprint, `later-v1-${"a".repeat(16)}`);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM later_deferrals").get()?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Later D1 claim fails closed as conflict on a different material fingerprint", async () => {
  const { database, store } = await testDatabase();
  try {
    assert.deepEqual(await store.claim(claim()), { kind: "CLAIMED" });
    assert.deepEqual(
      await store.claim(claim(evidence(`later-v1-${"b".repeat(16)}`))),
      { kind: "CONFLICT" },
    );
    assert.equal((await store.read("decision-hermes-deals-783"))?.stateFingerprint, `later-v1-${"a".repeat(16)}`);
  } finally {
    database.close();
  }
});

test("Later D1 replace performs explicit fingerprint CAS and supports replay after a concurrent equivalent replace", async () => {
  const { database, store } = await testDatabase();
  try {
    const first = evidence();
    const next = evidence(`later-v1-${"b".repeat(16)}`, "2026-08-28T08:00:00.000Z");
    assert.deepEqual(await store.claim(claim(first)), { kind: "CLAIMED" });

    assert.deepEqual(
      await store.replace({ expectedStateFingerprint: first.stateFingerprint, claim: claim(next) }),
      { kind: "REPLACED" },
    );
    assert.equal((await store.read(first.decisionId))?.stateFingerprint, next.stateFingerprint);

    assert.deepEqual(
      await store.replace({
        expectedStateFingerprint: first.stateFingerprint,
        claim: claim({ ...next, deferredAt: "2026-08-28T08:01:00.000Z" }),
      }),
      { kind: "REPLAY" },
    );
    assert.equal((await store.read(first.decisionId))?.deferredAt, "2026-08-28T08:00:00.000Z");
  } finally {
    database.close();
  }
});

test("Later D1 replace never blind-overwrites stale or missing expected state", async () => {
  const { database, store } = await testDatabase();
  try {
    const first = evidence();
    const next = evidence(`later-v1-${"b".repeat(16)}`);
    const third = evidence(`later-v1-${"c".repeat(16)}`);
    assert.deepEqual(await store.claim(claim(first)), { kind: "CLAIMED" });

    assert.deepEqual(
      await store.replace({ expectedStateFingerprint: `later-v1-${"d".repeat(16)}`, claim: claim(next) }),
      { kind: "CONFLICT" },
    );
    assert.equal((await store.read(first.decisionId))?.stateFingerprint, first.stateFingerprint);

    assert.deepEqual(
      await store.replace({ expectedStateFingerprint: first.stateFingerprint, claim: claim(next) }),
      { kind: "REPLACED" },
    );
    assert.deepEqual(
      await store.replace({ expectedStateFingerprint: first.stateFingerprint, claim: claim(third) }),
      { kind: "CONFLICT" },
    );
    assert.equal((await store.read(first.decisionId))?.stateFingerprint, next.stateFingerprint);

    assert.deepEqual(
      await store.replace({
        expectedStateFingerprint: first.stateFingerprint,
        claim: claim({ ...third, decisionId: "missing-decision" }),
      }),
      { kind: "CONFLICT" },
    );
  } finally {
    database.close();
  }
});

test("Later D1 persistence rejects malformed input and stored decision/project identity mismatch", async () => {
  const { database, store } = await testDatabase();
  try {
    await assert.rejects(
      store.claim(claim({ ...evidence(), stateFingerprint: "not-a-fingerprint" } as LaterDeferralEvidence)),
      D1LaterDeferralStoreError,
    );
    await assert.rejects(
      store.claim({ ...claim(), actor: { subject: " bad ", email: null } }),
      D1LaterDeferralStoreError,
    );

    database
      .prepare(
        `INSERT INTO later_deferrals (
          decision_id, schema_version, project_id, issue_number, pr_number,
          state_fingerprint, deferred_at, actor_subject, actor_email
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "decision-hermes-deals-783",
        "other-project",
        782,
        783,
        `later-v1-${"a".repeat(16)}`,
        "2026-08-28T07:45:00.000Z",
        "access-user-123",
        null,
      );

    await assert.rejects(store.claim(claim()), D1LaterDeferralStoreError);
  } finally {
    database.close();
  }
});

test("Later D1 replace rejects a no-op fingerprint replacement", async () => {
  const { database, store } = await testDatabase();
  try {
    const first = evidence();
    assert.deepEqual(await store.claim(claim(first)), { kind: "CLAIMED" });
    await assert.rejects(
      store.replace({ expectedStateFingerprint: first.stateFingerprint, claim: claim(first) }),
      D1LaterDeferralStoreError,
    );
  } finally {
    database.close();
  }
});
