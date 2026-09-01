import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAuthoritativeNeedsChangesEligibility,
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

test("unverified GitHub writes are stripped while Later and Open PR are preserved", () => {
  const suppressed = suppressUnverifiedGitHubWriteActions(decision());
  assert.deepEqual(suppressed.allowedActions, ["LATER", "OPEN_PR"]);

  const hydrated = applyAuthoritativeNeedsChangesEligibility(decision(), true);
  assert.deepEqual(hydrated.allowedActions, ["NEEDS_CHANGES", "LATER", "OPEN_PR"]);
  assert.equal(hydrated.allowedActions.includes("MERGE"), false);

  const blocked = applyAuthoritativeNeedsChangesEligibility(decision(), false);
  assert.deepEqual(blocked.allowedActions, ["LATER", "OPEN_PR"]);
});

test("exact authoritative projected evidence enables only Needs changes eligibility", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const eligible = await readAuthoritativeNeedsChangesEligibility(decision(), project, {
    fetcher: async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return Response.json(projected());
    },
  });

  assert.equal(eligible, true);
  assert.equal(
    observedUrl,
    "/api/github/reconcile?repository=rozkalnsandris%2Fops-workflows&issue=4&pull=5",
  );
  assert.equal(observedInit?.method, "GET");
  assert.equal(observedInit?.cache, "no-store");
  assert.equal(observedInit?.credentials, "same-origin");
  assert.equal(new Headers(observedInit?.headers).get("Accept"), "application/json");
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
  assert.equal(
    await readAuthoritativeNeedsChangesEligibility(decision({ projectId: "hermes-tech" }), readOnlyProject, { fetcher }),
    false,
  );
  assert.equal(
    await readAuthoritativeNeedsChangesEligibility(decision({ issueNumber: null }), project, { fetcher }),
    false,
  );
  assert.equal(
    await readAuthoritativeNeedsChangesEligibility(
      decision({ currentHeadSha: "cccccccccccccccccccccccccccccccccccccccc" }),
      project,
      { fetcher },
    ),
    false,
  );
  assert.equal(fetchCalls, 0);
});

test("blocked, stale, malformed and transport evidence all fail closed", async () => {
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
    const eligible = await readAuthoritativeNeedsChangesEligibility(decision(), project, {
      fetcher: async () => responseFactory(),
    });
    assert.equal(eligible, false);
  }
});
