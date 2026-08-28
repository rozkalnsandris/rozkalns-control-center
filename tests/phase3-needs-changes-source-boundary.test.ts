import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
const routeSource = readFileSync(resolve(process.cwd(), "src/worker/github-needs-changes-route.ts"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
const clientSource = readFileSync(resolve(process.cwd(), "src/react-app/decision-action-client.ts"), "utf8");
const policySource = readFileSync(resolve(process.cwd(), "src/shared/project-policy.ts"), "utf8");
const liveDashboardSource = readFileSync(resolve(process.cwd(), "src/shared/live-dashboard.ts"), "utf8");
const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
const installationSession = readFileSync(
  resolve(process.cwd(), "src/integrations/github/app-installation-session.ts"),
  "utf8",
);
const writerSource = readFileSync(
  resolve(process.cwd(), "src/integrations/github/pull-request-review-write.ts"),
  "utf8",
);
const decisionSource = readFileSync(
  resolve(process.cwd(), "src/shared/needs-changes-decision.ts"),
  "utf8",
);

test("Phase 3 Needs changes route and confirmed UI client stay capability-gated and fail closed on incomplete live identity", () => {
  assert.doesNotMatch(workerIndex, /pull-request-review-write|needs-changes-decision/);
  assert.match(workerIndex, /GITHUB_NEEDS_CHANGES_ROUTE_PATH/);
  assert.match(routeSource, /GITHUB_NEEDS_CHANGES_ROUTE_PATH = "\/api\/github\/needs-changes"/);
  assert.match(routeSource, /authenticateRequest/);
  assert.match(routeSource, /project\.canRequestChanges !== true/);

  assert.match(appSource, /postDecisionAction/);
  assert.match(appSource, /ActionConfirmationDialog/);
  assert.doesNotMatch(appSource, /\/api\/github\/needs-changes/);
  assert.match(clientSource, /"\/api\/github\/needs-changes"/);
  assert.match(clientSource, /method:\s*"POST"/);

  assert.match(policySource, /repository: "rozkalnsandris\/ops-workflows"[\s\S]*?canRequestChanges: true/);
  assert.match(liveDashboardSource, /policy\.canRequestChanges/);
  assert.match(liveDashboardSource, /decision\.issueNumber !== null/);
  assert.match(liveDashboardSource, /decision\.workflowState === "MERGE_READY"/);

  assert.equal(installationSession.includes("pull_requests:write"), false);
  assert.equal(wranglerConfig.includes("pull_requests:write"), false);
  assert.equal(wranglerConfig.includes("CONTROL_GITHUB_WRITE"), false);

  assert.match(writerSource, /pull_requests:write/);
  assert.match(writerSource, /REQUEST_CHANGES/);
  assert.match(writerSource, /commit_id/);
  assert.match(writerSource, /redirect:\s*"manual"/);
  assert.doesNotMatch(writerSource, /contents:write/i);
  assert.doesNotMatch(writerSource, /\/merge\b/);

  assert.match(decisionSource, /reconcileAuthoritativePullRequestDecision/);
  assert.match(decisionSource, /AUTHORIZATION_STALE_HEAD/);
  assert.match(decisionSource, /AUTHORIZATION_STALE_BASE/);
  assert.match(decisionSource, /IDEMPOTENCY_IN_PROGRESS/);
  assert.match(decisionSource, /WRITE_OUTCOME_UNKNOWN/);
  assert.doesNotMatch(decisionSource, /fetch\s*\(/);
  assert.doesNotMatch(decisionSource, /Authorization\s*:/);
});
