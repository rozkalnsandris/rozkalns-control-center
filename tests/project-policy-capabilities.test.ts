import assert from "node:assert/strict";
import test from "node:test";

import {
  RepositoryNeedsChangesNotAllowedError,
  explicitlyExcludedRepositories,
  managedProjectPolicies,
  requireManagedProjectPolicy,
  requireNeedsChangesProjectPolicy,
  resolveManagedProjectPolicy,
  resolveNeedsChangesProjectPolicy,
} from "../src/shared/project-policy.js";

test("all managed projects remain read-enabled while Needs changes defaults false", () => {
  assert.equal(managedProjectPolicies.length, 6);

  for (const policy of managedProjectPolicies) {
    assert.equal(policy.enabled, true);
    assert.equal(policy.githubReadEnabled, true);
    assert.equal(policy.canRequestChanges, false);

    assert.equal(resolveManagedProjectPolicy(policy.repository)?.id, policy.id);
    assert.equal(resolveManagedProjectPolicy(policy.repository.toUpperCase())?.id, policy.id);
    assert.equal(requireManagedProjectPolicy(policy.repository).id, policy.id);

    assert.equal(resolveNeedsChangesProjectPolicy(policy.repository), null);
    assert.throws(
      () => requireNeedsChangesProjectPolicy(policy.repository),
      RepositoryNeedsChangesNotAllowedError,
    );
  }
});

test("Needs changes capability fails closed for excluded and unknown repositories", () => {
  for (const repository of explicitlyExcludedRepositories) {
    assert.equal(resolveManagedProjectPolicy(repository), null);
    assert.equal(resolveNeedsChangesProjectPolicy(repository), null);
    assert.throws(
      () => requireNeedsChangesProjectPolicy(repository),
      RepositoryNeedsChangesNotAllowedError,
    );
  }

  const unknown = "rozkalnsandris/not-managed";
  assert.equal(resolveManagedProjectPolicy(unknown), null);
  assert.equal(resolveNeedsChangesProjectPolicy(unknown), null);
  assert.throws(
    () => requireNeedsChangesProjectPolicy(unknown),
    RepositoryNeedsChangesNotAllowedError,
  );
});
