import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
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

test("Phase 3 Needs changes boundary remains source-only and cannot mutate from Worker or UI", () => {
  for (const forbidden of [
    "pull-request-review-write",
    "needs-changes-decision",
    "/api/actions/needs-changes",
    "/api/github/needs-changes",
  ]) {
    assert.equal(workerIndex.includes(forbidden), false, `unexpected Worker wiring: ${forbidden}`);
  }

  assert.equal(appSource.includes("/api/actions/needs-changes"), false);
  assert.equal(appSource.includes("/api/github/needs-changes"), false);
  assert.match(appSource, /demo only/);

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
