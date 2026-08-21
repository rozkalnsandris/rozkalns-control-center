import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  resolveCloudflareContinuationRuntime,
  type CloudflareContinuationRuntimeBindings,
} from "../src/integrations/cloudflare/continuation-runtime.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

const NOW = "2026-08-21T18:30:00.000Z";
const MAIN_SHA = "a".repeat(40);

class ReadOnlyEmptyD1 implements D1DatabaseLike {
  readonly queries: string[] = [];

  prepare(query: string): D1PreparedStatementLike {
    this.queries.push(query);
    return {
      bind() {
        return this;
      },
      async run<Row>(): Promise<D1RunResultLike<Row>> {
        return { success: true, meta: { changes: 0 }, results: [] };
      },
    };
  }
}

function readyBindings(database: D1DatabaseLike): CloudflareContinuationRuntimeBindings {
  return {
    CONTROL_CONTINUATION_RUNTIME_ENABLED: "true",
    CONTROL_DB: database,
    GITHUB_APP_PRIVATE_KEY_PEM: "test-private-key",
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_INSTALLATION_ID: "123",
  };
}

test("continuation runtime stays dormant unless the feature flag is exactly true", () => {
  let inspected = 0;
  const bindings = {
    CONTROL_CONTINUATION_RUNTIME_ENABLED: "false",
    get CONTROL_DB() {
      inspected += 1;
      throw new Error("D1 must stay uninspected");
    },
    get GITHUB_APP_PRIVATE_KEY_PEM() {
      inspected += 1;
      throw new Error("GitHub bindings must stay uninspected");
    },
  } as CloudflareContinuationRuntimeBindings;

  assert.deepEqual(resolveCloudflareContinuationRuntime(bindings), { status: "DISABLED" });
  assert.equal(inspected, 0);
  assert.deepEqual(
    resolveCloudflareContinuationRuntime({ CONTROL_CONTINUATION_RUNTIME_ENABLED: "true " }),
    { status: "DISABLED" },
  );
});

test("exactly enabled but incomplete bindings fail closed without D1 or GitHub I/O", () => {
  let prepares = 0;
  let fetches = 0;
  const resolution = resolveCloudflareContinuationRuntime(
    {
      CONTROL_CONTINUATION_RUNTIME_ENABLED: "true",
      CONTROL_DB: {
        prepare() {
          prepares += 1;
          throw new Error("must not query");
        },
      },
      GITHUB_APP_PRIVATE_KEY_PEM: "test-private-key",
      GITHUB_APP_CLIENT_ID: "test-client-id",
    },
    {
      fetchRequest: async () => {
        fetches += 1;
        throw new Error("must not fetch");
      },
    },
  );

  assert.deepEqual(resolution, { status: "INVALID" });
  assert.equal(prepares, 0);
  assert.equal(fetches, 0);
});

test("READY runtime construction is side-effect free", () => {
  const database = new ReadOnlyEmptyD1();
  let fetches = 0;
  const resolution = resolveCloudflareContinuationRuntime(readyBindings(database), {
    now: () => NOW,
    fetchRequest: async () => {
      fetches += 1;
      throw new Error("construction must not fetch");
    },
  });

  assert.equal(resolution.status, "READY");
  assert.equal(database.queries.length, 0);
  assert.equal(fetches, 0);
});

test("NOT_FOUND recovery performs bounded D1 reads and no GitHub request", async () => {
  const database = new ReadOnlyEmptyD1();
  let fetches = 0;
  const resolution = resolveCloudflareContinuationRuntime(readyBindings(database), {
    now: () => NOW,
    fetchRequest: async () => {
      fetches += 1;
      throw new Error("NOT_FOUND must not fetch GitHub");
    },
  });
  assert.equal(resolution.status, "READY");
  if (resolution.status !== "READY") return;

  assert.deepEqual(
    await resolution.runtime.recoverAndCoordinate({
      campaignId: "campaign-1",
      projectId: "hermes-deals",
      repository: "rozkalnsandris/hermes-deals",
      expectedMainSha: MAIN_SHA,
    }),
    { kind: "NOT_FOUND" },
  );
  assert.equal(database.queries.length, 1);
  assert.match(database.queries[0], /^SELECT\b/u);
  assert.equal(fetches, 0);
});

test("Worker composition and production config keep continuation dormant", () => {
  const workerSource = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wranglerSource = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");

  assert.match(workerSource, /resolveCloudflareContinuationRuntime/u);
  assert.match(workerSource, /export function resolveContinuationRuntime\(env: Env\)/u);
  assert.equal((workerSource.match(/resolveContinuationRuntime\(env/u) ?? []).length, 1);
  assert.doesNotMatch(wranglerSource, /CONTROL_CONTINUATION_RUNTIME_ENABLED/u);
});
