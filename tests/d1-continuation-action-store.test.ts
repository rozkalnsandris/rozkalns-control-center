import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { D1PreparedStatementLike, D1RunResultLike } from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import type { D1BatchDatabaseLike } from "../src/integrations/cloudflare/d1-continuation-current-ready-store.js";
import { D1ContinuationCampaignReader } from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";
import { D1ContinuationActionStore } from "../src/integrations/cloudflare/d1-continuation-action-store.js";
import { continuationFingerprint, type ContinuationActionRequest } from "../src/shared/continuation-action.js";
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
    assert.ok(this.#values.length <= 100, "D1 parameter ceiling");
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


const main = "a".repeat(40);
const repository = "rozkalnsandris/ops-workflows";
const requestedAt = "2026-09-15T12:00:00.000Z";
async function setup(options: BatchOptions = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0007_continuation_campaigns.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0014_continuation_action_audit.sql", "utf8"));
  sqlite.prepare("INSERT INTO continuation_campaigns VALUES (?, 1, ?, ?, 'source', 'CONTINUE_ISSUES', 1, 0, ?, NULL, NULL, NULL, NULL, ?, ?)").run("campaign:ops", "ops-workflows", repository, main, requestedAt, requestedAt);
  const db = new SqliteBatchDatabase(sqlite, options);
  const found = await new D1ContinuationCampaignReader(db).read({ campaignId: "campaign:ops", projectId: "ops-workflows", repository, expectedMainSha: main });
  assert.equal(found.kind, "FOUND");
  if (found.kind !== "FOUND") throw new Error("missing campaign");
  const revision = await continuationFingerprint(found);
  const request: ContinuationActionRequest = { action: "PAUSE", repository, campaignId: "campaign:ops", expectedMainSha: main, revision, requestId: "pause_request_123456789" };
  const actor = { subject: "owner", email: null };
  const fingerprint = await continuationFingerprint({ request, actor });
  const next = { ...found.campaign, paused: true, updatedAt: "2026-09-15T12:00:01.000Z" };
  const resultRevision = await continuationFingerprint({ ...found, campaign: next });
  return { sqlite, db, found, request, actor, fingerprint, next, resultRevision, store: new D1ContinuationActionStore(db) };
}

test("atomic Pause stores actor/request/result and replay does not mutate again", async () => {
  const x = await setup();
  try {
    await x.store.persist(x.request, x.actor, x.fingerprint, x.found, x.next, x.resultRevision);
    assert.equal((x.sqlite.prepare("SELECT paused FROM continuation_campaigns").get() as { paused: number }).paused, 1);
    const receipt = await x.store.receipt(x.request.requestId, x.fingerprint);
    assert.equal(receipt?.result, "APPLIED");
    assert.equal(receipt?.result_revision, x.resultRevision);
    assert.equal(x.db.batchCalls, 1);
    await assert.rejects(x.store.receipt(x.request.requestId, "b".repeat(64)), /IDEMPOTENCY_CONFLICT/);
    await assert.rejects(x.store.persist(x.request, x.actor, x.fingerprint, x.found, x.next, x.resultRevision), /UNIQUE/);
    assert.equal((x.sqlite.prepare("SELECT count(*) AS n FROM continuation_action_audit").get() as { n: number }).n, 1);
  } finally { x.sqlite.close(); }
});

test("full-state CAS rejects changed human gate and preserves the drifted campaign", async () => {
  const x = await setup();
  try {
    x.sqlite.exec("UPDATE continuation_campaigns SET human_gate = 'MERGE'");
    await assert.rejects(x.store.persist(x.request, x.actor, x.fingerprint, x.found, x.next, x.resultRevision), /PERSISTENCE_CONFLICT/);
    const row = x.sqlite.prepare("SELECT paused, human_gate FROM continuation_campaigns").get();
    assert.deepEqual({ ...row }, { paused: 0, human_gate: "MERGE" });
    assert.equal((x.sqlite.prepare("SELECT result FROM continuation_action_audit").get() as { result: string }).result, "CONFLICT");
  } finally { x.sqlite.close(); }
});

test("full-state CAS rejects an added task even when campaign timestamp is unchanged", async () => {
  const x = await setup();
  try {
    x.sqlite.prepare("INSERT INTO continuation_tasks VALUES ('campaign:ops', 'task:1', 'ops-workflows', ?, 1, 'READY', NULL, NULL, 1, ?)").run(repository, requestedAt);
    await assert.rejects(x.store.persist(x.request, x.actor, x.fingerprint, x.found, x.next, x.resultRevision), /PERSISTENCE_CONFLICT/);
    assert.equal((x.sqlite.prepare("SELECT paused FROM continuation_campaigns").get() as { paused: number }).paused, 0);
  } finally { x.sqlite.close(); }
});


test("atomic comparison supports the full 100-task continuation contract", async () => {
  const x = await setup();
  try {
    for (let i = 1; i <= 100; i++) x.sqlite.prepare("INSERT INTO continuation_tasks VALUES ('campaign:ops', ?, 'ops-workflows', ?, ?, 'READY', NULL, NULL, 1, ?)").run(`task:${i}`, repository, i, requestedAt);
    const found = await new D1ContinuationCampaignReader(x.db).read({ campaignId: "campaign:ops", projectId: "ops-workflows", repository, expectedMainSha: main });
    if (found.kind !== "FOUND") throw new Error("missing campaign");
    const request = { ...x.request, revision: await continuationFingerprint(found) };
    const fingerprint = await continuationFingerprint({ request, actor: x.actor });
    await x.store.persist(request, x.actor, fingerprint, found, x.next, await continuationFingerprint({ ...found, campaign: x.next }));
    assert.equal((x.sqlite.prepare("SELECT paused FROM continuation_campaigns").get() as { paused: number }).paused, 1);
  } finally { x.sqlite.close(); }
});
