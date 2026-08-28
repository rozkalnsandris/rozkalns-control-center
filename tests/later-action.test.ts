import assert from "node:assert/strict";
import test from "node:test";

import type { ControlDashboardData, DecisionReadModel } from "../src/shared/control-model.js";
import {
  executeLaterAction,
  LaterActionError,
} from "../src/shared/later-action.js";
import { laterDecisionStateFingerprint } from "../src/shared/later-decision.js";
import type {
  LaterDeferralClaimInput,
  LaterDeferralClaimResult,
  LaterDeferralReplaceInput,
  LaterDeferralReplaceResult,
  LaterDeferralStore,
  PersistedLaterDeferral,
} from "../src/shared/later-deferral-store.js";

const NOW = "2026-08-28T08:10:00.000Z";
const ACTOR = { subject: "user-123", email: "andris@example.invalid" } as const;

function decision(overrides: Partial<DecisionReadModel> = {}): DecisionReadModel {
  return {
    id: "decision-1",
    projectId: "ops-workflows",
    workflowState: "WAITING",
    issueNumber: 4,
    issueTitle: "Canary",
    prNumber: 3,
    prTitle: "Disposable PR",
    prUrl: "https://github.com/rozkalnsandris/ops-workflows/pull/3",
    ci: "PASS",
    review: "PASS",
    deployImpact: "NO_DEPLOY",
    changedFiles: 2,
    expectedHeadSha: "1111111111111111111111111111111111111111",
    currentHeadSha: "1111111111111111111111111111111111111111",
    mainSha: "2222222222222222222222222222222222222222",
    reason: "Waiting for a human decision.",
    lastReconciledAt: NOW,
    allowedActions: ["LATER", "OPEN_PR"],
    ...overrides,
  };
}

function dashboard(item: DecisionReadModel): ControlDashboardData {
  return {
    generatedAt: NOW,
    projects: [
      {
        id: "ops-workflows",
        displayName: "Ops Workflows",
        repository: "rozkalnsandris/ops-workflows",
        enabled: true,
        productionAdapter: "none",
        status: "WAITING",
        openPullRequests: 1,
        openIssues: 1,
      },
    ],
    decisions: [item],
  };
}

class MemoryLaterStore implements LaterDeferralStore {
  current: PersistedLaterDeferral | null = null;
  reads = 0;
  claims = 0;
  replaces = 0;

  async claim(input: LaterDeferralClaimInput): Promise<LaterDeferralClaimResult> {
    this.claims += 1;
    if (this.current === null) {
      this.current = { ...input.evidence, actor: input.actor };
      return { kind: "CLAIMED" };
    }
    if (this.current.stateFingerprint === input.evidence.stateFingerprint) {
      return { kind: "REPLAY" };
    }
    return { kind: "CONFLICT" };
  }

  async read(): Promise<PersistedLaterDeferral | null> {
    this.reads += 1;
    return this.current;
  }

  async replace(input: LaterDeferralReplaceInput): Promise<LaterDeferralReplaceResult> {
    this.replaces += 1;
    if (
      this.current === null ||
      this.current.stateFingerprint !== input.expectedStateFingerprint
    ) {
      return { kind: "CONFLICT" };
    }
    if (this.current.stateFingerprint === input.claim.evidence.stateFingerprint) {
      return { kind: "REPLAY" };
    }
    this.current = { ...input.claim.evidence, actor: input.claim.actor };
    return { kind: "REPLACED" };
  }
}

function requestFor(item: DecisionReadModel) {
  return {
    repository: "rozkalnsandris/ops-workflows",
    projectId: "ops-workflows",
    decisionId: item.id,
    expectedStateFingerprint: laterDecisionStateFingerprint(item),
    actor: ACTOR,
  } as const;
}

test("Later action defers once and exact replay is idempotent", async () => {
  const item = decision();
  const store = new MemoryLaterStore();
  const dependencies = {
    readDashboard: async () => dashboard(item),
    store,
    clock: () => new Date(NOW),
  };

  const first = await executeLaterAction(requestFor(item), dependencies);
  const replay = await executeLaterAction(requestFor(item), dependencies);

  assert.equal(first.status, "DEFERRED");
  assert.equal(replay.status, "REPLAYED");
  assert.equal(store.claims, 2);
  assert.equal(store.replaces, 0);
  assert.equal(store.current?.actor.subject, ACTOR.subject);
});

test("Later action fails stale expected state before persistence", async () => {
  const item = decision();
  const store = new MemoryLaterStore();

  await assert.rejects(
    executeLaterAction(
      {
        ...requestFor(item),
        expectedStateFingerprint: "later-v1-0000000000000000",
      },
      {
        readDashboard: async () => dashboard(item),
        store,
        clock: () => new Date(NOW),
      },
    ),
    (error: unknown) =>
      error instanceof LaterActionError && error.code === "AUTHORIZATION_STALE_STATE",
  );

  assert.equal(store.reads, 0);
  assert.equal(store.claims, 0);
  assert.equal(store.replaces, 0);
});

test("Later action refuses fresh decision state without LATER authority", async () => {
  const item = decision({ allowedActions: ["OPEN_PR"] });
  const store = new MemoryLaterStore();

  await assert.rejects(
    executeLaterAction(requestFor(item), {
      readDashboard: async () => dashboard(item),
      store,
      clock: () => new Date(NOW),
    }),
    (error: unknown) =>
      error instanceof LaterActionError && error.code === "ACTION_NOT_ALLOWED",
  );

  assert.equal(store.reads, 0);
  assert.equal(store.claims, 0);
  assert.equal(store.replaces, 0);
});

test("Later action CAS-replaces an older deferral after material state change", async () => {
  const oldDecision = decision();
  const changedDecision = decision({
    ci: "FAIL",
    workflowState: "CI_FAILED",
    reason: "CI became red after the earlier defer.",
  });
  const store = new MemoryLaterStore();

  await executeLaterAction(requestFor(oldDecision), {
    readDashboard: async () => dashboard(oldDecision),
    store,
    clock: () => new Date(NOW),
  });

  const result = await executeLaterAction(requestFor(changedDecision), {
    readDashboard: async () => dashboard(changedDecision),
    store,
    clock: () => new Date("2026-08-28T08:11:00.000Z"),
  });

  assert.equal(result.status, "REPLACED");
  assert.equal(store.replaces, 1);
  assert.equal(store.current?.stateFingerprint, laterDecisionStateFingerprint(changedDecision));
});

test("Later action maps authoritative dashboard failure to fail-closed reconciliation error", async () => {
  const item = decision();
  const store = new MemoryLaterStore();

  await assert.rejects(
    executeLaterAction(requestFor(item), {
      readDashboard: async () => {
        throw new Error("upstream unavailable");
      },
      store,
      clock: () => new Date(NOW),
    }),
    (error: unknown) =>
      error instanceof LaterActionError && error.code === "RECONCILIATION_FAILED",
  );

  assert.equal(store.reads, 0);
});
