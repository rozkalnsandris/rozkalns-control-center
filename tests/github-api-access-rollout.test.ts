import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const manifestPath = path.join(root, '.github', 'github-api-access-v1.json');
const routingPath = path.join(root, '.github', 'start-mode-routing.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as any;
const routing = JSON.parse(readFileSync(routingPath, 'utf8')) as any;

test('pins the accepted shared GitHub API access contract without widening authority', () => {
  assert.equal(manifest.schema, 'rozkalns.github-api-access-consumer.v1');
  assert.equal(manifest.status, 'ROLLOUT_SOURCE_ONLY');
  assert.equal(manifest.repository, 'rozkalnsandris/rozkalns-control-center');
  assert.equal(manifest.shared_contract.revision, '3bb0740b5f0a8ce631d2ff79f1acc4999ff6ed2c');

  assert.equal(manifest.read_plan.serial_by_default_per_repository_lane, true);
  assert.equal(manifest.read_plan.minimum_sufficient_retrieval_required, true);
  assert.equal(manifest.read_plan.changed_files_on_demand_only, true);
  assert.equal(manifest.read_plan.tight_polling_allowed, false);
  assert.equal(manifest.read_plan.historical_workflow_runs_by_default, false);

  assert.equal(manifest.mutation_boundary.expected_head_binding_required_when_supported, true);
  assert.equal(manifest.mutation_boundary.automatic_duplicate_mutation_after_403, false);
  assert.equal(manifest.mutation_boundary.automatic_duplicate_mutation_after_429, false);
  assert.equal(manifest.mutation_boundary.automatic_duplicate_mutation_after_timeout, false);
  assert.equal(manifest.mutation_boundary.automatic_duplicate_mutation_after_transport_error, false);
  assert.equal(manifest.mutation_boundary.post_dispatch_uncertainty_fail_closed, true);
  assert.equal(manifest.mutation_boundary.minimal_read_only_reconciliation_only, true);
  assert.equal(manifest.mutation_boundary.stop_after_ambiguous_outcome, true);
  assert.equal(manifest.mutation_boundary.merge_success_implies_live_or_deploy_authority, false);

  assert.equal(manifest.local_stricter_rules.fast_merge_requires_explicit_owner_decision, true);
  assert.equal(manifest.local_stricter_rules.source_only_full_requires_explicit_issue_scoped_activation, true);
  assert.equal(manifest.local_stricter_rules.live_deploy_runtime_requires_exact_authority, true);
  assert.equal(
    manifest.local_stricter_rules.cloudflare_secrets_permissions_production_data_require_exact_authority,
    true,
  );
});

test('routes START, SYNC and turpini through the pinned API-access consumer contract', () => {
  assert.equal(routing.github_api_access.consumer_manifest, '.github/github-api-access-v1.json');
  assert.equal(
    routing.github_api_access.shared_contract_revision,
    '3bb0740b5f0a8ce631d2ff79f1acc4999ff6ed2c',
  );
  assert.deepEqual(routing.github_api_access.applies_to, ['START', 'SYNC', 'turpini']);

  assert.equal(routing.default_continuation_mode, 'FAST-LANE v2.2');
  assert.equal(routing.bare_continuation_result, 'FAST-LANE v2.2');
  assert.equal(routing.explicit_modes['AUTO-RUN-FULL'].requires_explicit_current_command_token, true);
  assert.equal(routing.explicit_modes['AUTO-RUN-FULL'].requires_issue_argument, true);
  assert.equal(routing.explicit_modes['LIVE-ALL'].requires_explicit_current_command_token, true);
});

test('synthetic post-dispatch ambiguity always reconciles once and stops without duplicate mutation', () => {
  const cases = [
    ['post_dispatch_429', 'MUTATION_OUTCOME_UNKNOWN_RATE_LIMIT'],
    ['post_dispatch_timeout', 'MUTATION_OUTCOME_UNKNOWN_TIMEOUT'],
    ['post_dispatch_transport_error', 'MUTATION_OUTCOME_UNKNOWN_TRANSPORT'],
  ] as const;

  assert.equal(manifest.synthetic_acceptance.intentionally_exhaust_real_quota, false);

  for (const [key, expectedDisposition] of cases) {
    const outcome = manifest.synthetic_acceptance[key];
    assert.equal(outcome.disposition, expectedDisposition);
    assert.equal(outcome.automatic_duplicate_mutation_allowed, false);
    assert.equal(outcome.requires_reconciliation, true);
    assert.equal(outcome.stop, true);
  }
});
