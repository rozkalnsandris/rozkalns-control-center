import assert from "node:assert/strict";
import test from "node:test";

import { managedProjectPolicies } from "../src/shared/project-policy.js";
import {
  CONTROL_AUTHORIZATION_PREFIX,
  ProductionAuthorizationError,
  getProductionOperation,
  parseProductionAuthorizationSyntax,
  productionOperationRegistry,
  resolveProductionAuthorization,
} from "../src/shared/production-authorization.js";

const sha = "a".repeat(40);
const ci = "31814935559";

function expectAuthorizationError(input: string, code: ProductionAuthorizationError["code"]) {
  assert.throws(
    () => resolveProductionAuthorization(input),
    (error: unknown) => error instanceof ProductionAuthorizationError && error.code === code,
  );
}

test("authorization syntax carries only operation id plus exact SHA and CI evidence", () => {
  const parsed = parseProductionAuthorizationSyntax(
    `${CONTROL_AUTHORIZATION_PREFIX} hermes-deals.workflow-dispatch ${sha} ci ${ci}`,
  );

  assert.deepEqual(parsed, {
    raw: `${CONTROL_AUTHORIZATION_PREFIX} hermes-deals.workflow-dispatch ${sha} ci ${ci}`,
    operationId: "hermes-deals.workflow-dispatch",
    expectedMainSha: sha,
    expectedCiRunId: ci,
  });
});

test("authorization syntax rejects stale-shape and arbitrary target fields", () => {
  for (const input of [
    `${CONTROL_AUTHORIZATION_PREFIX} hermes-deals.workflow-dispatch ${sha.toUpperCase()} ci ${ci}`,
    `${CONTROL_AUTHORIZATION_PREFIX} hermes-deals.workflow-dispatch ${sha} ci 0`,
    `${CONTROL_AUTHORIZATION_PREFIX} hermes-deals.workflow-dispatch ${sha} ci ${ci} workflow deploy.yml`,
    `${CONTROL_AUTHORIZATION_PREFIX} hermes-deals.workflow-dispatch rozkalnsandris/other ${sha} ci ${ci}`,
    ` ${CONTROL_AUTHORIZATION_PREFIX} hermes-deals.workflow-dispatch ${sha} ci ${ci}`,
  ]) {
    assert.throws(
      () => parseProductionAuthorizationSyntax(input),
      (error: unknown) =>
        error instanceof ProductionAuthorizationError && error.code === "AUTHORIZATION_FORMAT_INVALID",
    );
  }
});

test("every managed project has an explicit disabled workflow-dispatch operation", () => {
  for (const project of managedProjectPolicies) {
    const operation = getProductionOperation(`${project.id}.workflow-dispatch`);
    assert.ok(operation);
    assert.equal(operation.projectId, project.id);
    assert.equal(operation.repository, project.repository);
    assert.equal(operation.executor, "github-actions-dispatch");
    assert.equal(operation.state, "disabled");
    if (operation.executor === "github-actions-dispatch") {
      assert.equal(operation.target, null);
      assert.deepEqual(operation.requiredGitHubAppPermissions, { actions: "write" });
    }
    assert.equal(operation.requiresExactMainSha, true);
    assert.equal(operation.requiresExactMainCi, true);
  }
});

test("no managed workflow-dispatch operation is executable in this source increment", () => {
  const workflowDispatchOperations = productionOperationRegistry.filter(
    (operation) => operation.executor === "github-actions-dispatch",
  );

  assert.equal(workflowDispatchOperations.length, managedProjectPolicies.length);
  assert.ok(workflowDispatchOperations.every((operation) => operation.state === "disabled"));

  for (const project of managedProjectPolicies) {
    expectAuthorizationError(
      `${CONTROL_AUTHORIZATION_PREFIX} ${project.id}.workflow-dispatch ${sha} ci ${ci}`,
      "OPERATION_DISABLED",
    );
  }
});

test("completed initial D1 migration is represented as retired and cannot be replayed", () => {
  const operation = getProductionOperation("control.initial-production-d1-migration");
  assert.ok(operation);
  assert.equal(operation.state, "retired");
  assert.equal(operation.executor, "cloudflare-d1");
  assert.equal(operation.repository, "rozkalnsandris/rozkalns-control-center");

  expectAuthorizationError(
    `${CONTROL_AUTHORIZATION_PREFIX} control.initial-production-d1-migration ${sha} ci ${ci}`,
    "OPERATION_RETIRED",
  );
});

test("unknown operation ids fail closed", () => {
  expectAuthorizationError(
    `${CONTROL_AUTHORIZATION_PREFIX} unknown.workflow-dispatch ${sha} ci ${ci}`,
    "OPERATION_UNKNOWN",
  );
});
