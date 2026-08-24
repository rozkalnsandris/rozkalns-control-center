import assert from "node:assert/strict";
import test from "node:test";

import {
  RepositoryMergeNotAllowedError,
  RepositoryNeedsChangesNotAllowedError,
  explicitlyExcludedRepositories,
  managedProjectPolicies,
  requireManagedProjectPolicy,
  requireMergeProjectPolicy,
  requireNeedsChangesProjectPolicy,
  resolveManagedProjectPolicy,
  resolveMergeProjectPolicy,
  resolveNeedsChangesProjectPolicy,
} from "../src/shared/project-policy.js";

const CANARY_REPOSITORY = "rozkalnsandris/ops-workflows";

test("exactly one managed project enables the Needs changes canary while Merge remains disabled everywhere", () => {
  assert.equal(managedProjectPolicies.length, 6);

  const enabled = managedProjectPolicies.filter((policy) => policy.canRequestChanges);
  assert.deepEqual(enabled.map((policy) => policy.repository), [CANARY_REPOSITORY]);
  assert.equal(enabled[0]?.id, "ops-workflows");
  assert.equal(enabled[0]?.productionAdapter, "none");
  assert.equal(managedProjectPolicies.filter((policy) => policy.canMerge).length, 0);

  for (const policy of managedProjectPolicies) {
    assert.equal(policy.enabled, true);
    assert.equal(policy.githubReadEnabled, true);
    assert.equal(policy.canMerge, false);
    assert.equal(resolveManagedProjectPolicy(policy.repository)?.id, policy.id);
    assert.equal(resolveManagedProjectPolicy(policy.repository.toUpperCase())?.id, policy.id);
    assert.equal(requireManagedProjectPolicy(policy.repository).id, policy.id);
    assert.equal(resolveMergeProjectPolicy(policy.repository), null);
    assert.equal(resolveMergeProjectPolicy(policy.repository.toUpperCase()), null);
    assert.throws(() => requireMergeProjectPolicy(policy.repository), RepositoryMergeNotAllowedError);

    if (policy.repository === CANARY_REPOSITORY) {
      assert.equal(policy.canRequestChanges, true);
      assert.equal(resolveNeedsChangesProjectPolicy(policy.repository)?.id, policy.id);
      assert.equal(resolveNeedsChangesProjectPolicy(policy.repository.toUpperCase())?.id, policy.id);
      assert.equal(requireNeedsChangesProjectPolicy(policy.repository).id, policy.id);
      continue;
    }

    assert.equal(policy.canRequestChanges, false);
    assert.equal(resolveNeedsChangesProjectPolicy(policy.repository), null);
    assert.throws(
      () => requireNeedsChangesProjectPolicy(policy.repository),
      RepositoryNeedsChangesNotAllowedError,
    );
  }
});

test("Needs changes and Merge capabilities fail closed for excluded and unknown repositories", () => {
  for (const repository of explicitlyExcludedRepositories) {
    assert.equal(resolveManagedProjectPolicy(repository), null);
    assert.equal(resolveNeedsChangesProjectPolicy(repository), null);
    assert.equal(resolveMergeProjectPolicy(repository), null);
    assert.throws(
      () => requireNeedsChangesProjectPolicy(repository),
      RepositoryNeedsChangesNotAllowedError,
    );
    assert.throws(() => requireMergeProjectPolicy(repository), RepositoryMergeNotAllowedError);
  }

  const unknown = "rozkalnsandris/not-managed";
  assert.equal(resolveManagedProjectPolicy(unknown), null);
  assert.equal(resolveNeedsChangesProjectPolicy(unknown), null);
  assert.equal(resolveMergeProjectPolicy(unknown), null);
  assert.throws(
    () => requireNeedsChangesProjectPolicy(unknown),
    RepositoryNeedsChangesNotAllowedError,
  );
  assert.throws(() => requireMergeProjectPolicy(unknown), RepositoryMergeNotAllowedError);
});
