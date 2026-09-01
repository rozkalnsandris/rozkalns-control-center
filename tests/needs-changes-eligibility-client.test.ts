import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAuthoritativeGitHubWriteEligibility,
  applyAuthoritativeNeedsChangesEligibility,
  readAuthoritativeGitHubWriteEligibility,
  readAuthoritativeNeedsChangesEligibility,
  suppressUnverifiedGitHubWriteActions,
} from "../src/react-app/needs-changes-eligibility-client.js";
import type { DecisionReadModel, ProjectReadModel } from "../src/shared/control-model.js";

const project: ProjectReadModel = {
  id: "ops-workflows",
  displayName: "Ops Workflows",
  repository: "rozkalnsandris/ops-workflows",
  enabled: true,
  productionAdapter: "none",
  status: "ATTENTION",
  openPullRequests: 1,
  openIssues: 1,
};

function decision(overrides: Partial<DecisionReadModel> = {}): DecisionReadModel {
  return {
    id: "github:ops-workflows:pr:5",
    projectId: "ops-workflows",
    workflowState: "WAITING",
    issueNumber: 4,
    issueTitle: "Canary issue",
    prNumber: 5,
    prTitle: "Canary pull request",
    prUrl: "https://github.com/rozkalnsandris/ops-workflows/pull/5",
    ci: "PASS",
    review: "NOT_REQUIRED",
    deployImpact: "UNKNOWN",
    changedFiles: 2,
    expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    reason: "Lightweight observation is not authoritative for GitHub writes.",
    lastReconciledAt: "2026-09-01T17:59:00.000Z",
    allowedActions: ["MERGE", "NEEDS_CHANGES", "LATER", "OPEN_PR"],
    ...overrides,
  };
}

function projected(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "PROJECTED",
    repository: project.repository,
    issueNumber: 4,
    pullNumber: 5,
    observedAt: "2026-09-01T18:00:00.000Z",
    commitStatusCoverage: "NOT_REQUESTED",
    policy: { coverage: "COMPLETE", sources: ["RULESET"], blockedReasons: [] },
    decision: decision({
      workflowState: "MERGE_READY",
      allowedActions: ["OPEN_PR"],
      lastReconciledAt: "2026-09-01T18:00:00.000Z",
    }),
    ...overrides,
  };
}

test("unverified GitHub writes are stripped while authoritative policy flags compose independently", () => {
  const suppressed = suppressUnverifiedGitHubWriteActions(decision());
  assert.deepEqual(suppressed.allowedActions, ["LATER", "OPEN_PR"]);

  const dual = applyAuthoritativeGitHubWriteEligibility(decision(), { merge: true, needsChanges: true });
  assert.deepEqual(dual.allowedActions, ["MERGE", "NEEDS_CHANGES", "LATER", "OPEN_PR"]);

  const mergeOnly = applyAuthoritativeGitHubWriteEligibility(decision(), { merge: true, needsChanges: false });
  assert.deepEqual(mergeOnly.allowedActions, ["MERGE", "LATER", "OPEN_PR"]);

  const needsChangesOnly = applyAuthoritativeGitHubWriteEligibility(decision(), { merge: false, needsChanges: true });
  assert.deepEqual(needsChangesOnly.allowedActions, ["NEEDS_CHANGES", "LATER", "OPEN_PR"]);

  const blocked = applyAuthoritativeGitHubWriteEligibility(decision(), { merge: false, needsChanges: false });
  assert.deepEqual(blocked.allowedActions, ["LATER", "OPEN_PR"]);

  const legacyNeedsChanges = applyAuthoritativeNeedsChangesEligibility(decision(), true);
  assert.deepEqual(legacyNeedsChanges.allowedActions, ["NEEDS_CHANGES", "LATER", "OPEN_PR"]);
  assert.equal(legacyNeedsChanges.allowedActions.includes("MERGE"), false);
});

test("one exact authoritative GET returns policy-bounded Merge and Needs changes eligibility", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  let fetchCalls = 0;
  const eligibility = await readAuthoritativeGitHubWriteEligibility(decision(), project, {
    fetcher: async (input, init) => {
      fetchCalls += 1;
      observedUrl = String(input);
      observedInit = init;
      return Response.json(projected());
    },
  });

  assert.deepEqual(eligibility, { merge: true, needsChanges: true });
  assert.equal(fetchCalls, 1);
  assert.equal(
    observedUrl,
    "/api/github/reconcile?repository=rozkalnsandris%2Fops-workflows&issue=4&pull=5",
  );
  assert.equal(observedInit?.method, "GET");
  assert.equal(observedInit?.cache, "no-store");
  assert.equal(observedInit?.credentials, "same-origin");
  assert.equal(new Headers(observedInit?.headers).get("Accept"), "application/json");
});

test("legacy Needs changes reader remains policy-bounded", async () => {
  let fetchCalls = 0;
  const eligible = await readAuthoritativeNeedsChangesEligibility(decision(), project, {
    fetcher: async () => {
      fetchCalls += 1;
      return Response.json(projected());
    },
  });

  assert.equal(eligible, true);
  assert.equal(fetchCalls, 1);
});

test("policy mismatch and incomplete local identity fail closed before any GET", async () => {
  let fetchCalls = 0;
  const fetcher = async (): Promise<Response> => {
    fetchCalls += 1;
    return Response.json(projected());
  };

  const readOnlyProject: ProjectReadModel = {
    ...project,
    id: "hermes-tech",
    repository: "rozkalnsandris/hermes-tech",
  };
  assert.deepEqual(
    await readAuthoritativeGitHubWriteEligibility(decision({ projectId: "hermes-tech" }), readOnlyProject, { fetcher }),
    { merge: false, needsChanges: false },
  );
  assert.deepEqual(
    await readAuthoritativeGitHubWriteEligibility(decision({ issueNumber: null }), project, { fetcher }),
    { merge: false, needsChanges: false },
  );
  assert.deepEqual(
    await readAuthoritativeGitHubWriteEligibility(
      decision({ currentHeadSha: "cccccccccccccccccccccccccccccccccccccccc" }),
      project,
      { fetcher },
    ),
    { merge: false, needsChanges: false },
  );
  assert.equal(fetchCalls, 0);
});

test("blocked, stale, malformed and transport evidence all fail closed for both GitHub writes", async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => Response.json({ ...projected(), kind: "BLOCKED" }),
    async () => Response.json(projected({ repository: "rozkalnsandris/hermes-tech" })),
    async () => Response.json(projected({ issueNumber: 99 })),
    async () => Response.json(projected({ decision: decision({ workflowState: "WAITING" }) })),
    async () => Response.json(projected({ decision: decision({ review: "PENDING", workflowState: "MERGE_READY" }) })),
    async () => Response.json(projected({ decision: decision({ mainSha: "cccccccccccccccccccccccccccccccccccccccc", workflowState: "MERGE_READY" }) })),
    async () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => Response.json({ error: "LIVE_READ_FAILED" }, { status: 502 }),
  ];

  for (const responseFactory of cases) {
    const eligibility = await readAuthoritativeGitHubWriteEligibility(decision(), project, {
      fetcher: async () => responseFactory(),
    });
    assert.deepEqual(eligibility, { merge: false, needsChanges: false });
  }
});
