import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlAuthorizationError,
  controlOperationPolicies,
  parseControlAuthorization,
  requireControlOperationPolicy,
} from "../src/shared/control-authorization.js";
import { managedProjectPolicies } from "../src/shared/project-policy.js";

const sha = "446092231d4254088289324449310f15d4c0f878";
const ciRunId = 31813566303;

function authorization(projectId: string) {
  return `authorize control ${projectId} workflow_dispatch ${sha} ci ${ciRunId}`;
}

function expectCode(input: string, code: string) {
  assert.throws(
    () => parseControlAuthorization(input),
    (error: unknown) => error instanceof ControlAuthorizationError && error.code === code,
  );
}

test("authorization resolves every enabled managed project from the source registry", () => {
  for (const project of managedProjectPolicies.filter((policy) => policy.enabled && policy.githubReadEnabled)) {
    assert.deepEqual(parseControlAuthorization(authorization(project.id)), {
      projectId: project.id,
      repository: project.repository,
      operation: "workflow_dispatch",
      expectedMainSha: sha,
      expectedCiRunId: ciRunId,
    });
  }
});

test("authorization never accepts an arbitrary repository or unknown project id", () => {
  expectCode(
    `authorize control rozkalnsandris/hermes-deals workflow_dispatch ${sha} ci ${ciRunId}`,
    "AUTHORIZATION_FORMAT_INVALID",
  );
  expectCode(
    `authorize control hermes-email-skill workflow_dispatch ${sha} ci ${ciRunId}`,
    "PROJECT_NOT_MANAGED",
  );
  expectCode(
    `authorize control unknown-project workflow_dispatch ${sha} ci ${ciRunId}`,
    "PROJECT_NOT_MANAGED",
  );
});

test("authorization format is exact and fail closed", () => {
  const valid = authorization("hermes-deals");
  for (const invalid of [
    `${valid}\n`,
    `${valid} extra`,
    ` ${valid}`,
    valid.replace("workflow_dispatch", "deploy"),
    valid.replace(sha, sha.toUpperCase()),
    valid.replace(sha, sha.slice(0, 39)),
    valid.replace(`ci ${ciRunId}`, "ci 0"),
    valid.replace(`ci ${ciRunId}`, "ci -1"),
  ]) {
    expectCode(invalid, "AUTHORIZATION_FORMAT_INVALID");
  }
});

test("workflow dispatch policy is source-controlled and live-disabled by default", () => {
  const policy = requireControlOperationPolicy("workflow_dispatch");
  assert.deepEqual(policy, {
    id: "workflow_dispatch",
    liveEnabled: false,
    requiredGitHubPermissions: ["actions:write"],
    targetSelection: "source_controlled_allowlist",
  });
  assert.equal(controlOperationPolicies.workflow_dispatch.liveEnabled, false);
  assert.deepEqual(controlOperationPolicies.workflow_dispatch.requiredGitHubPermissions, ["actions:write"]);
});

test("authorization source contract contains no repository write or administration permission", () => {
  const serialized = JSON.stringify(controlOperationPolicies);
  assert.doesNotMatch(serialized, /contents:write/);
  assert.doesNotMatch(serialized, /administration:/);
  assert.doesNotMatch(serialized, /pull_requests:write/);
});
