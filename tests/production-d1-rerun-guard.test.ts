import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gate = "scripts/cloudflare-d1-migration-gate.mjs";
const workflow = ".github/workflows/production-d1.yml";
const sha = "a".repeat(40);
const ci = "123456";

function actionsEnv(runAttempt: string): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "rozkalnsandris/rozkalns-control-center",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: "rozkalnsandris/rozkalns-control-center/.github/workflows/production-d1.yml@refs/heads/main",
    GITHUB_RUN_ATTEMPT: runAttempt,
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    CLOUDFLARE_ACCOUNT_ID: "70e29dbca0e8363358659102d2b74178",
  };
}

test("completed production D1 workflow is retired before any privileged boundary", async () => {
  const source = await readFile(workflow, "utf8");
  assert.match(source, /name: Retired Production D1 Canary/);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /if: \$\{\{ false \}\}/);
  assert.doesNotMatch(source, /issue_comment:/);
  assert.doesNotMatch(source, /environment: production/);
  assert.doesNotMatch(source, /CLOUDFLARE_D1_TOKEN|secrets\./);
});

test("historical controller still rejects GitHub Actions reruns before credential or network use", () => {
  const result = spawnSync(
    process.execPath,
    [gate, "--mode", "apply", "--expected-sha", sha, "--expected-ci-run-id", ci],
    { encoding: "utf8", env: actionsEnv("2") },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /STOP=ACTIONS_RERUN_FORBIDDEN/);
  assert.doesNotMatch(result.stderr, /CLOUDFLARE_API_TOKEN_REQUIRED|CI_READ_FAILED|CLOUDFLARE_READ_FAILED/);
});
