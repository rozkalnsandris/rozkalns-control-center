import assert from "node:assert/strict";
import test from "node:test";

import {
  selectLatestEffectiveCheckRuns,
  selectLatestEffectiveWorkflowRuns,
} from "../src/shared/github-evidence-selection.js";
import { aggregateCiState } from "../src/shared/github-projection.js";
import {
  keepLatestExactHeadCheckRuns,
  keepLatestExactHeadWorkflowRuns,
  mapGitHubCheckRun,
  mapGitHubWorkflowRun,
} from "../src/shared/github-rest-mappers.js";
import type { CheckRunRead, WorkflowRunRead } from "../src/shared/source-control-read.js";

const HEAD = "1111111111111111111111111111111111111111";

function check(overrides: Partial<CheckRunRead> = {}): CheckRunRead {
  return {
    id: "check-1",
    name: "validate",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    appId: 15368,
    startedAt: "2026-08-11T10:00:00Z",
    completedAt: "2026-08-11T10:01:00Z",
    detailsUrl: null,
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowRunRead> = {}): WorkflowRunRead {
  return {
    id: "run-1",
    workflowId: "1234",
    runNumber: 1,
    runAttempt: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    createdAt: "2026-08-11T10:00:00Z",
    updatedAt: "2026-08-11T10:01:00Z",
    runStartedAt: "2026-08-11T10:00:10Z",
    htmlUrl: "https://github.com/example/actions/runs/1",
    ...overrides,
  };
}

const checkPolicy = {
  requiredChecks: [{ context: "validate", integrationId: 15368 }],
  requiredWorkflowNames: [] as string[],
};

const workflowPolicy = {
  requiredChecks: [] as { context: string; integrationId: number | null }[],
  requiredWorkflowNames: ["CI"],
};

test("new successful Check rerun supersedes an older failure for the same context and App", () => {
  const state = aggregateCiState(
    [
      check({ id: "old", conclusion: "failure", startedAt: "2026-08-11T10:00:00Z" }),
      check({ id: "new", conclusion: "success", startedAt: "2026-08-11T10:05:00Z" }),
    ],
    [],
    [],
    checkPolicy,
  );

  assert.equal(state, "PASS");
});

test("new in-progress Check rerun supersedes an older success", () => {
  const state = aggregateCiState(
    [
      check({ id: "old", conclusion: "success", startedAt: "2026-08-11T10:00:00Z" }),
      check({ id: "new", status: "in_progress", conclusion: null, startedAt: "2026-08-11T10:05:00Z", completedAt: null }),
    ],
    [],
    [],
    checkPolicy,
  );

  assert.equal(state, "RUNNING");
});

test("same Check name from different producer Apps is not collapsed", () => {
  const effective = selectLatestEffectiveCheckRuns([
    check({ id: "app-a", appId: 15368, conclusion: "success", startedAt: "2026-08-11T10:05:00Z" }),
    check({ id: "app-b", appId: 999, conclusion: "failure", startedAt: "2026-08-11T10:06:00Z" }),
  ]);

  assert.equal(effective.length, 2);
  assert.equal(
    aggregateCiState(effective, [], [], {
      requiredChecks: [{ context: "validate", integrationId: null }],
      requiredWorkflowNames: [],
    }),
    "FAIL",
  );
});

test("ambiguous same-key Check ordering stays conservative instead of fabricating PASS", () => {
  const state = aggregateCiState(
    [
      check({ id: "success", conclusion: "success", startedAt: null, completedAt: null }),
      check({ id: "failure", conclusion: "failure", startedAt: null, completedAt: null }),
    ],
    [],
    [],
    checkPolicy,
  );

  assert.equal(state, "FAIL");
});

test("newer workflow run number supersedes an older failed run", () => {
  const state = aggregateCiState(
    [],
    [],
    [
      workflow({ id: "old", runNumber: 10, conclusion: "failure" }),
      workflow({ id: "new", runNumber: 11, conclusion: "success", createdAt: "2026-08-11T10:05:00Z", updatedAt: "2026-08-11T10:06:00Z" }),
    ],
    workflowPolicy,
  );

  assert.equal(state, "PASS");
});

test("newer workflow attempt controls state for the same run number", () => {
  const state = aggregateCiState(
    [],
    [],
    [
      workflow({ id: "attempt-1", runNumber: 20, runAttempt: 1, conclusion: "success" }),
      workflow({ id: "attempt-2", runNumber: 20, runAttempt: 2, status: "in_progress", conclusion: null, updatedAt: "2026-08-11T10:05:00Z" }),
    ],
    workflowPolicy,
  );

  assert.equal(state, "RUNNING");
});

test("workflow records without provable identity are not silently collapsed", () => {
  const runs = [
    workflow({ id: "unknown-a", workflowId: null, conclusion: "success" }),
    workflow({ id: "unknown-b", workflowId: null, conclusion: "failure" }),
  ];

  assert.equal(selectLatestEffectiveWorkflowRuns(runs).length, 2);
  assert.equal(aggregateCiState([], [], runs, workflowPolicy), "FAIL");
});

test("REST mappers preserve documented ordering fields and reject malformed provided timestamps", () => {
  const mappedCheck = mapGitHubCheckRun({
    id: 1,
    name: "validate",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD,
    app: { id: 15368 },
    started_at: "2026-08-11T10:00:00Z",
    completed_at: "2026-08-11T10:01:00Z",
    details_url: null,
  });
  assert.equal(mappedCheck.startedAt, "2026-08-11T10:00:00Z");

  const mappedWorkflow = mapGitHubWorkflowRun({
    id: 2,
    workflow_id: 1234,
    run_number: 11,
    run_attempt: 2,
    name: "CI",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD,
    created_at: "2026-08-11T10:00:00Z",
    updated_at: "2026-08-11T10:02:00Z",
    run_started_at: "2026-08-11T10:00:05Z",
    html_url: "https://github.com/example/actions/runs/2",
  });
  assert.equal(mappedWorkflow.workflowId, "1234");
  assert.equal(mappedWorkflow.runAttempt, 2);

  assert.throws(
    () =>
      mapGitHubCheckRun({
        id: 3,
        name: "validate",
        status: "completed",
        conclusion: "success",
        head_sha: HEAD,
        app: null,
        started_at: "not-a-time",
        completed_at: null,
        details_url: null,
      }),
    /ISO timestamp/,
  );
});

test("REST latest helpers filter stale heads before selecting rerun evidence", () => {
  const checks = keepLatestExactHeadCheckRuns(
    [
      { id: 1, name: "validate", status: "completed", conclusion: "failure", head_sha: HEAD, app: { id: 15368 }, started_at: "2026-08-11T10:00:00Z", completed_at: "2026-08-11T10:01:00Z", details_url: null },
      { id: 2, name: "validate", status: "completed", conclusion: "success", head_sha: HEAD, app: { id: 15368 }, started_at: "2026-08-11T10:05:00Z", completed_at: "2026-08-11T10:06:00Z", details_url: null },
      { id: 3, name: "validate", status: "completed", conclusion: "failure", head_sha: "2".repeat(40), app: { id: 15368 }, started_at: "2026-08-11T10:10:00Z", completed_at: "2026-08-11T10:11:00Z", details_url: null },
    ],
    HEAD,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.id, "2");

  const runs = keepLatestExactHeadWorkflowRuns(
    [
      { id: 10, workflow_id: 1234, run_number: 10, run_attempt: 1, name: "CI", status: "completed", conclusion: "failure", head_sha: HEAD, created_at: "2026-08-11T10:00:00Z", updated_at: "2026-08-11T10:01:00Z", run_started_at: "2026-08-11T10:00:05Z", html_url: "https://example/10" },
      { id: 11, workflow_id: 1234, run_number: 11, run_attempt: 1, name: "CI", status: "completed", conclusion: "success", head_sha: HEAD, created_at: "2026-08-11T10:05:00Z", updated_at: "2026-08-11T10:06:00Z", run_started_at: "2026-08-11T10:05:05Z", html_url: "https://example/11" },
    ],
    HEAD,
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, "11");
});
