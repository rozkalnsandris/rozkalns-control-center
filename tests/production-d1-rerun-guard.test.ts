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

test("production D1 workflow keeps reruns outside the environment job", async () => {
  const source = await readFile(workflow, "utf8");
  assert.match(source, /github\.run_attempt == '1' &&/);
  assert.match(source, /environment: production/);
  assert.match(source, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_TOKEN \}\}/);
  assert.match(source, /cancel-in-progress: false/);
});

test("first GitHub Actions attempt passes execution-context validation before credential checks", () => {
  const result = spawnSync(
    process.execPath,
    [gate, "--mode", "apply", "--expected-sha", sha, "--expected-ci-run-id", ci],
    { encoding: "utf8", env: actionsEnv("1") },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /STOP=CLOUDFLARE_API_TOKEN_REQUIRED/);
  assert.doesNotMatch(result.stderr, /ACTIONS_RERUN_FORBIDDEN|EXECUTION_CONTEXT_INVALID/);
});

test("GitHub Actions rerun is rejected before credential or network use", () => {
  const result = spawnSync(
    process.execPath,
    [gate, "--mode", "apply", "--expected-sha", sha, "--expected-ci-run-id", ci],
    { encoding: "utf8", env: actionsEnv("2") },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /STOP=ACTIONS_RERUN_FORBIDDEN/);
  assert.doesNotMatch(result.stderr, /CLOUDFLARE_API_TOKEN_REQUIRED|CI_READ_FAILED|CLOUDFLARE_READ_FAILED/);
});
