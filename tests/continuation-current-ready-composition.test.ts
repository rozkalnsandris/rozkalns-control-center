import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { ContinuationPlanResult } from "../src/shared/continuation-plan.js";
import {
  composeContinuationCurrentReady,
  ContinuationCurrentReadyCompositionError,
  type ContinuationCurrentReadyCompositionDependencies,
} from "../src/integrations/cloudflare/continuation-current-ready-composition.js";
import { planContinuationCurrentReadyTransition } from "../src/integrations/cloudflare/continuation-current-ready-transition.js";
import { planContinuationNextTaskTransition } from "../src/integrations/cloudflare/continuation-next-task-transition.js";
import type { ContinuationPostMergeTransitionProposal } from "../src/integrations/cloudflare/continuation-post-merge-transition.js";
import type { ContinuationCampaignRecoveryEvidence } from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const COMPLETED_TASK_ID = "task:517";
const NEXT_TASK_ID = "task:518";
const OLD_MAIN_SHA = "1".repeat(40);
const MAIN_SHA = "2".repeat(40);
const HEAD_SHA = "3".repeat(40);
const POST_MERGE_AT = "2026-08-24T18:00:00.000Z";
const NEXT_TASK_UPDATED_AT = "2026-08-24T17:59:00.000Z";
const READY_AT = "2026-08-24T18:01:00.000Z";

type ReadyPlan = Extract<ContinuationPlanResult, { readonly kind: "READY" }>;

function postMergeTransition(): ContinuationPostMergeTransitionProposal {
  return {
    schemaVersion: 1,
    kind: "POST_MERGE_TRANSITION",
    mergeEvidence: {
      merged: true,
      taskId: COMPLETED_TASK_ID,
      issueNumber: 517,
      pullRequestNumber: 404,
      expectedHeadSha: HEAD_SHA,
      previousMainSha: OLD_MAIN_SHA,
      mergeSha: MAIN_SHA,
      observedAt: POST_MERGE_AT,
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
      expectedMainSha: MAIN_SHA,
      currentTask: { taskId: COMPLETED_TASK_ID, state: "DONE" },
      nextTaskId: null,
      humanGate: null,
      observedAt: POST_MERGE_AT,
      updatedAt: POST_MERGE_AT,
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
        updatedAt: POST_MERGE_AT,
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
        updatedAt: NEXT_TASK_UPDATED_AT,
      },
    ],
  };
}

function readyPlan(): ReadyPlan {
  return {
    kind: "READY",
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: NEXT_TASK_ID,
    issueNumber: 518,
    expectedMainSha: MAIN_SHA,
    observedAt: READY_AT,
  };
}

function recoveryFromPostMerge(
  transition: ContinuationPostMergeTransitionProposal,
): ContinuationCampaignRecoveryEvidence {
  return { kind: "FOUND", campaign: transition.campaign, tasks: transition.tasks };
}

function reservedRecovery(
  transition: ContinuationPostMergeTransitionProposal,
  plan: ReadyPlan,
): ContinuationCampaignRecoveryEvidence {
  const reserved = planContinuationNextTaskTransition(transition, plan);
  return { kind: "FOUND", campaign: reserved.campaign, tasks: reserved.tasks };
}

function finalRecovery(
  transition: ContinuationPostMergeTransitionProposal,
  plan: ReadyPlan,
): ContinuationCampaignRecoveryEvidence {
  const reserved = reservedRecovery(transition, plan);
  const currentReady = planContinuationCurrentReadyTransition(reserved, plan);
  return { kind: "FOUND", campaign: currentReady.campaign, tasks: currentReady.tasks };
}

function expectCompositionCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof ContinuationCurrentReadyCompositionError && error.code === code;
}

test("non-READY re-selection performs no durable read or persistence", async () => {
  const transition = postMergeTransition();
  let durableCalls = 0;
  const dependencies: ContinuationCurrentReadyCompositionDependencies = {
    async reselect() {
      return { kind: "NO_ELIGIBLE_TASK" };
    },
    async reserve() {
      durableCalls += 1;
      throw new Error("reservation must not run");
    },
    async read() {
      durableCalls += 1;
      throw new Error("durable read must not run");
    },
    async persistCurrentReady() {
      durableCalls += 1;
      throw new Error("current READY write must not run");
    },
  };

  assert.deepEqual(await composeContinuationCurrentReady(transition, dependencies), {
    kind: "NO_CURRENT_READY",
    plan: { kind: "NO_ELIGIBLE_TASK" },
  });
  assert.equal(durableCalls, 0);
});

test("composes reservation, exact recovery and current READY persistence", async () => {
  const transition = postMergeTransition();
  const plan = readyPlan();
  const afterReservation = reservedRecovery(transition, plan);
  const reads: ContinuationCampaignRecoveryEvidence[] = [
    recoveryFromPostMerge(transition),
    afterReservation,
  ];
  const calls: string[] = [];

  const dependencies: ContinuationCurrentReadyCompositionDependencies = {
    async reselect(received) {
      calls.push("reselect");
      assert.deepEqual(received, transition);
      return plan;
    },
    async reserve(expected, proposal) {
      calls.push("reserve");
      assert.deepEqual(expected, transition);
      assert.equal(proposal.kind, "NEXT_TASK_TRANSITION");
      assert.equal(proposal.campaign.nextTaskId, NEXT_TASK_ID);
      return { kind: "APPLIED" };
    },
    async read(identity) {
      calls.push("read");
      assert.deepEqual(identity, {
        campaignId: CAMPAIGN_ID,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        expectedMainSha: MAIN_SHA,
      });
      const next = reads.shift();
      assert.ok(next);
      return next;
    },
    async persistCurrentReady(recovery, receivedPlan) {
      calls.push("persistCurrentReady");
      assert.deepEqual(recovery, afterReservation);
      assert.deepEqual(receivedPlan, plan);
      return { kind: "APPLIED" };
    },
  };

  assert.deepEqual(await composeContinuationCurrentReady(transition, dependencies), {
    kind: "CURRENT_READY",
    plan,
    reservation: { kind: "APPLIED" },
    currentReady: { kind: "APPLIED" },
  });
  assert.deepEqual(calls, ["reselect", "read", "reserve", "read", "persistCurrentReady"]);
  assert.equal(reads.length, 0);
});

test("missing post-reservation recovery fails closed before current READY persistence", async () => {
  const transition = postMergeTransition();
  const plan = readyPlan();
  const reads: ContinuationCampaignRecoveryEvidence[] = [
    recoveryFromPostMerge(transition),
    { kind: "NOT_FOUND" },
  ];
  let currentReadyWrites = 0;

  await assert.rejects(
    composeContinuationCurrentReady(transition, {
      async reselect() {
        return plan;
      },
      async reserve() {
        return { kind: "APPLIED" };
      },
      async read() {
        const next = reads.shift();
        assert.ok(next);
        return next;
      },
      async persistCurrentReady() {
        currentReadyWrites += 1;
        return { kind: "APPLIED" };
      },
    }),
    expectCompositionCode("POST_RESERVATION_RECOVERY_MISMATCH"),
  );
  assert.equal(currentReadyWrites, 0);
});

test("drifted reserved recovery fails closed before current READY persistence", async () => {
  const transition = postMergeTransition();
  const plan = readyPlan();
  const expectedReserved = reservedRecovery(transition, plan);
  assert.equal(expectedReserved.kind, "FOUND");
  if (expectedReserved.kind !== "FOUND") return;

  const drifted: ContinuationCampaignRecoveryEvidence = {
    kind: "FOUND",
    campaign: { ...expectedReserved.campaign, nextTaskId: "task:519" },
    tasks: expectedReserved.tasks,
  };
  const reads: ContinuationCampaignRecoveryEvidence[] = [
    recoveryFromPostMerge(transition),
    drifted,
  ];
  let currentReadyWrites = 0;

  await assert.rejects(
    composeContinuationCurrentReady(transition, {
      async reselect() {
        return plan;
      },
      async reserve() {
        return { kind: "APPLIED" };
      },
      async read() {
        const next = reads.shift();
        assert.ok(next);
        return next;
      },
      async persistCurrentReady() {
        currentReadyWrites += 1;
        return { kind: "APPLIED" };
      },
    }),
    expectCompositionCode("POST_RESERVATION_RECOVERY_MISMATCH"),
  );
  assert.equal(currentReadyWrites, 0);
});

test("exact final-state replay is idempotent without repeating either persistence write", async () => {
  const transition = postMergeTransition();
  const plan = readyPlan();
  let reserveCalls = 0;
  let currentReadyCalls = 0;

  const result = await composeContinuationCurrentReady(transition, {
    async reselect() {
      return plan;
    },
    async reserve() {
      reserveCalls += 1;
      throw new Error("reservation replay must not run");
    },
    async read() {
      return finalRecovery(transition, plan);
    },
    async persistCurrentReady() {
      currentReadyCalls += 1;
      throw new Error("current READY replay must not run");
    },
  });

  assert.deepEqual(result, {
    kind: "CURRENT_READY",
    plan,
    reservation: { kind: "ALREADY_CURRENT_READY" },
    currentReady: { kind: "ALREADY_APPLIED" },
  });
  assert.equal(reserveCalls, 0);
  assert.equal(currentReadyCalls, 0);
});

test("source boundary keeps composed current READY dormant and non-executing", () => {
  const compositionSource = readFileSync(
    resolve(
      process.cwd(),
      "src/integrations/cloudflare/continuation-current-ready-composition.ts",
    ),
    "utf8",
  );
  const runtimeSource = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/continuation-runtime.ts"),
    "utf8",
  );
  const workerSource = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wranglerSource = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");

  assert.match(compositionSource, /planContinuationNextTaskTransition/u);
  assert.match(compositionSource, /planContinuationCurrentReadyTransition/u);
  assert.doesNotMatch(compositionSource, /\bWORKING\b/u);
  assert.match(runtimeSource, /reselectReserveAndPersistCurrentReady/u);
  assert.doesNotMatch(workerSource, /\.reselectReserveAndPersistCurrentReady\(/u);
  assert.doesNotMatch(wranglerSource, /CONTROL_CONTINUATION_RUNTIME_ENABLED/u);
});
