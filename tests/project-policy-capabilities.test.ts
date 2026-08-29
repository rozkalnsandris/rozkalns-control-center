import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryLaterNotAllowedError, RepositoryMergeNotAllowedError, RepositoryNeedsChangesNotAllowedError, explicitlyExcludedRepositories, managedProjectPolicies, requireLaterProjectPolicy, requireManagedProjectPolicy, requireMergeProjectPolicy, requireNeedsChangesProjectPolicy, resolveLaterProjectPolicy, resolveManagedProjectPolicy, resolveMergeProjectPolicy, resolveNeedsChangesProjectPolicy } from "../src/shared/project-policy.js";
const CANARY_REPOSITORY = "rozkalnsandris/ops-workflows";

test("ops-workflows is the only Needs changes, Merge and Later canary", () => {
  assert.equal(managedProjectPolicies.length, 6);
  assert.deepEqual(managedProjectPolicies.filter((policy) => policy.canRequestChanges).map((policy) => policy.repository), [CANARY_REPOSITORY]);
  assert.deepEqual(managedProjectPolicies.filter((policy) => policy.canMerge).map((policy) => policy.repository), [CANARY_REPOSITORY]);
  assert.deepEqual(managedProjectPolicies.filter((policy) => policy.canLater).map((policy) => policy.repository), [CANARY_REPOSITORY]);
  for (const policy of managedProjectPolicies) {
    assert.equal(policy.enabled, true); assert.equal(policy.githubReadEnabled, true); assert.equal(resolveManagedProjectPolicy(policy.repository)?.id, policy.id); assert.equal(requireManagedProjectPolicy(policy.repository).id, policy.id);
    if (policy.repository === CANARY_REPOSITORY) {
      assert.equal(policy.canRequestChanges, true); assert.equal(policy.canMerge, true); assert.equal(policy.canLater, true); assert.equal(policy.productionAdapter, "none"); assert.equal(resolveNeedsChangesProjectPolicy(policy.repository)?.id, policy.id); assert.equal(requireNeedsChangesProjectPolicy(policy.repository).id, policy.id); assert.equal(resolveMergeProjectPolicy(policy.repository)?.id, policy.id); assert.equal(resolveMergeProjectPolicy(policy.repository.toUpperCase())?.id, policy.id); assert.equal(requireMergeProjectPolicy(policy.repository).id, policy.id); assert.equal(resolveLaterProjectPolicy(policy.repository)?.id, policy.id); assert.equal(resolveLaterProjectPolicy(policy.repository.toUpperCase())?.id, policy.id); assert.equal(requireLaterProjectPolicy(policy.repository).id, policy.id); continue;
    }
    assert.equal(policy.canRequestChanges, false); assert.equal(policy.canMerge, false); assert.equal(policy.canLater, false); assert.equal(resolveNeedsChangesProjectPolicy(policy.repository), null); assert.equal(resolveMergeProjectPolicy(policy.repository), null); assert.equal(resolveLaterProjectPolicy(policy.repository), null); assert.throws(() => requireNeedsChangesProjectPolicy(policy.repository), RepositoryNeedsChangesNotAllowedError); assert.throws(() => requireMergeProjectPolicy(policy.repository), RepositoryMergeNotAllowedError); assert.throws(() => requireLaterProjectPolicy(policy.repository), RepositoryLaterNotAllowedError);
  }
});

test("Needs changes, Merge and Later fail closed for excluded and unknown repositories", () => {
  for (const repository of explicitlyExcludedRepositories) {
    assert.equal(resolveManagedProjectPolicy(repository), null); assert.equal(resolveNeedsChangesProjectPolicy(repository), null); assert.equal(resolveMergeProjectPolicy(repository), null); assert.equal(resolveLaterProjectPolicy(repository), null); assert.throws(() => requireNeedsChangesProjectPolicy(repository), RepositoryNeedsChangesNotAllowedError); assert.throws(() => requireMergeProjectPolicy(repository), RepositoryMergeNotAllowedError); assert.throws(() => requireLaterProjectPolicy(repository), RepositoryLaterNotAllowedError);
  }
  const unknown = "rozkalnsandris/not-managed"; assert.equal(resolveManagedProjectPolicy(unknown), null); assert.equal(resolveNeedsChangesProjectPolicy(unknown), null); assert.equal(resolveMergeProjectPolicy(unknown), null); assert.equal(resolveLaterProjectPolicy(unknown), null); assert.throws(() => requireNeedsChangesProjectPolicy(unknown), RepositoryNeedsChangesNotAllowedError); assert.throws(() => requireMergeProjectPolicy(unknown), RepositoryMergeNotAllowedError); assert.throws(() => requireLaterProjectPolicy(unknown), RepositoryLaterNotAllowedError);
});
