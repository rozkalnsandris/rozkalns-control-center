import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = "./scripts/cloudflare-ui-rollout-shared.mjs";

function runEvaluation(deployments: unknown[]) {
  const code = `
    import { singleDeploymentVersion } from ${JSON.stringify(helper)};
    const deployments = ${JSON.stringify(deployments)};
    const result = singleDeploymentVersion(deployments, "TEST");
    console.log(JSON.stringify(result));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

test("deployment history selects the first latest active deployment without requiring a one-record history", () => {
  const latest = {
    id: "new-deployment",
    versions: [{ version_id: "new-version", percentage: 100 }],
  };
  const historical = {
    id: "old-deployment",
    versions: [{ version_id: "old-version", percentage: 100 }],
  };

  const result = runEvaluation([latest, historical]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    deploymentId: "new-deployment",
    versionId: "new-version",
  });
});

test("latest deployment must still be exactly one version at 100 percent", () => {
  const result = runEvaluation([
    {
      id: "new-deployment",
      versions: [
        { version_id: "new-version", percentage: 50 },
        { version_id: "old-version", percentage: 50 },
      ],
    },
    {
      id: "old-deployment",
      versions: [{ version_id: "old-version", percentage: 100 }],
    },
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_DEPLOYMENT_VERSION/);
});

test("empty deployment history fails closed", () => {
  const result = runEvaluation([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_DEPLOYMENT_HISTORY_EMPTY/);
});
