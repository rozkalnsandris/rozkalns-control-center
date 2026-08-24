import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { ContinuationPlanResult } from "../src/shared/continuation-plan.js";
import {
  ContinuationCurrentReadyTransitionError,
} from "../src/integrations/cloudflare/continuation-current-ready-transition.js";
import {
  persistContinuationCurrentReady,
} from "../src/integrations/cloudflare/continuation-current-ready-persistence.js";
import {
  D1ContinuationCurrentReadyStoreError,
} from "../src/integrations/cloudflare/d1-continuation-current-ready-store.js";
import type { ContinuationCampaignRecoveryEvidence } from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const MAIN_SHA = "1".repeat(40);
const RESERVED_AT = "2026-08-24T16:00:00.000Z";
const READY_AT = "2026-08-24T16:01:00.000Z";

class QueryTrapD1 implements D1DatabaseLike {
  prepares = 0;

  prepare(): D1PreparedStatementLike {
    this.prepares += 1;
    throw new Error("D1 query must not run");
  }
}

function recovery(): ContinuationCampaignRecoveryEvidence & { readonly kind: "FOUND" } {
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
      currentTask: { taskId: "task:517", state: "DONE" },
      nextTaskId: "task:518",
      humanGate: null,
      observedAt: RESERVED_AT,
      updatedAt: RESERVED_AT,
    },
    tasks: [
      {
        taskId: "task:517",
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
        taskId: "task:518",
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: 518,
        taskState: "DISCOVERED",
        activePullRequestNumber: null,
        expectedHeadSha: null,
        priority: 20,
        updatedAt: RESERVED_AT,
      },
    ],
  };
}

function readyPlan(): Extract<ContinuationPlanResult, { readonly kind: "READY" }> {
  return {
    kind: "READY",
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: "task:518",
    issueNumber: 518,
    expectedMainSha: MAIN_SHA,
    observedAt: READY_AT,
  };
}

test("current READY persistence rejects missing transactional D1 support before querying", async () => {
  const database = new QueryTrapD1();

  await assert.rejects(
    persistContinuationCurrentReady(database, recovery(), readyPlan()),
    (error: unknown) =>
      error instanceof D1ContinuationCurrentReadyStoreError && error.code === "INVALID_INPUT",
  );
  assert.equal(database.prepares, 0);
});

test("invalid recovery evidence fails before constructing or querying the D1 store", async () => {
  const database = new QueryTrapD1();

  await assert.rejects(
    persistContinuationCurrentReady(database, { kind: "NOT_FOUND" }, readyPlan()),
    (error: unknown) =>
      error instanceof ContinuationCurrentReadyTransitionError &&
      error.code === "FOUND_RECOVERY_REQUIRED",
  );
  assert.equal(database.prepares, 0);
});

test("runtime wires only the inert current READY persistence adapter", () => {
  const persistenceSource = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/continuation-current-ready-persistence.ts"),
    "utf8",
  );
  const runtimeSource = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/continuation-runtime.ts"),
    "utf8",
  );
  const workerSource = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wranglerSource = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");

  assert.match(persistenceSource, /planContinuationCurrentReadyTransition/u);
  assert.match(persistenceSource, /D1ContinuationCurrentReadyStore/u);
  assert.match(runtimeSource, /persistContinuationCurrentReady/u);
  assert.match(runtimeSource, /async persistCurrentReady\(recovery, plan\)/u);
  assert.doesNotMatch(workerSource, /\.persistCurrentReady\(/u);
  assert.doesNotMatch(wranglerSource, /CONTROL_CONTINUATION_RUNTIME_ENABLED/u);
});
