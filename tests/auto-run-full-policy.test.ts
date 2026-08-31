import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type AutoRunPolicy = {
  schema_version: number;
  policy: string;
  repository: string;
  enablement_issue: number;
  controller_issue: number;
  lane_role: {
    normal_implementation_lane: string;
    safe_discovery_lane: string;
    fast_lane_may_infer_auto_run_full: boolean;
  };
  command: {
    syntax: string;
    requires_explicit_current_command: boolean;
    requires_exact_open_issue: boolean;
    may_be_inferred_from_context: boolean;
    single_command_is_owner_source_and_merge_authorization: boolean;
    single_command_is_live_authorization: boolean;
  };
  execution_model: {
    canonical_state: string;
    primary_resume: string;
    fallback_watchdog: string;
    event_triggered_work_required_for_correctness: boolean;
    scheduled_watchdog_max_frequency: string;
    event_triggered_task_max_runs_per_hour: number;
    event_triggered_task_max_runs_per_day: number;
  };
  activation: {
    activation_comment_schema: string;
    post_receipt_main_revalidation_required: boolean;
    activation_must_freeze: string[];
    authorization_receipt_required_before: string[];
  };
  strict_live_never_implied: string[];
  merge: {
    auto_run_full_command_is_explicit_owner_merge_authority_for_the_frozen_issue: boolean;
    strategy: string;
    source_head_must_be_frozen_before_any_merge_mechanism: boolean;
    when_immediately_mergeable: string;
    when_blocked_only_by_required_gates_and_head_is_frozen: string;
    native_auto_merge_is_not_attempted_for_already_clean_immediately_mergeable_pr: boolean;
    source_push_after_native_auto_merge_arm: boolean;
    correction_after_native_auto_merge_arm_requires_disable_before_push: boolean;
    if_safe_auto_merge_disable_is_unavailable_or_ambiguous: string;
    direct_merge_requires_expected_head_sha: boolean;
    repository_ruleset_bypass: boolean;
    force_merge: boolean;
    merge_authorizes_live_mutation: boolean;
  };
  live: {
    auto_run_full_command_is_live_authority: boolean;
    separate_explicit_owner_live_authorization_required: boolean;
    state_when_definition_of_done_requires_unapproved_strict_live: string;
  };
  completion: {
    post_merge_exact_main_verification_required: boolean;
    post_merge_exact_main_ci_required_when_repository_ci_runs_on_push: boolean;
    controller_returns_to_idle_on_done: boolean;
  };
  platform_constraints: {
    scheduled_tasks_active_limit_plus: number;
    native_auto_merge_only_applies_when_pull_request_cannot_merge_immediately: boolean;
  };
};

function readPolicy(): AutoRunPolicy {
  return JSON.parse(
    readFileSync(".github/auto-run-full-v2.json", "utf8"),
  ) as AutoRunPolicy;
}

test("AUTO-RUN FULL v2 is explicit, issue-scoped and GitHub-canonical", () => {
  const policy = readPolicy();

  assert.equal(policy.schema_version, 5);
  assert.equal(policy.policy, "AUTO-RUN FULL v2");
  assert.equal(policy.repository, "rozkalnsandris/rozkalns-control-center");
  assert.equal(policy.enablement_issue, 498);
  assert.equal(policy.controller_issue, 499);
  assert.equal(policy.lane_role.normal_implementation_lane, "AUTO-RUN FULL");
  assert.equal(policy.lane_role.safe_discovery_lane, "FAST-LANE v2.2");
  assert.equal(policy.lane_role.fast_lane_may_infer_auto_run_full, false);
  assert.equal(
    policy.command.syntax,
    "AUTO-RUN FULL rozkalns-control-center #<issue>",
  );
  assert.equal(policy.command.requires_explicit_current_command, true);
  assert.equal(policy.command.requires_exact_open_issue, true);
  assert.equal(policy.command.may_be_inferred_from_context, false);
  assert.equal(
    policy.command.single_command_is_owner_source_and_merge_authorization,
    true,
  );
  assert.equal(policy.command.single_command_is_live_authorization, false);
  assert.equal(policy.execution_model.canonical_state, "GITHUB");
  assert.equal(
    policy.activation.activation_comment_schema,
    "rozkalns.auto-run-full-authorization.v2",
  );
  assert.equal(policy.activation.post_receipt_main_revalidation_required, true);
  assert.ok(policy.activation.activation_must_freeze.includes("activation_main_sha"));
  assert.ok(policy.activation.authorization_receipt_required_before.includes("MERGE"));
});

test("hybrid exact-head merge avoids the already-clean auto-merge trap", () => {
  const policy = readPolicy();

  assert.equal(policy.merge.strategy, "HYBRID_EXACT_HEAD_V2");
  assert.equal(
    policy.merge.auto_run_full_command_is_explicit_owner_merge_authority_for_the_frozen_issue,
    true,
  );
  assert.equal(policy.merge.source_head_must_be_frozen_before_any_merge_mechanism, true);
  assert.equal(
    policy.merge.when_immediately_mergeable,
    "DIRECT_SQUASH_WITH_EXPECTED_HEAD_SHA",
  );
  assert.equal(
    policy.merge.when_blocked_only_by_required_gates_and_head_is_frozen,
    "ENABLE_GITHUB_AUTO_MERGE_IF_REPOSITORY_CAPABILITY_AVAILABLE",
  );
  assert.equal(
    policy.merge.native_auto_merge_is_not_attempted_for_already_clean_immediately_mergeable_pr,
    true,
  );
  assert.equal(policy.merge.source_push_after_native_auto_merge_arm, false);
  assert.equal(
    policy.merge.correction_after_native_auto_merge_arm_requires_disable_before_push,
    true,
  );
  assert.equal(
    policy.merge.if_safe_auto_merge_disable_is_unavailable_or_ambiguous,
    "STOP_ERROR",
  );
  assert.equal(policy.merge.direct_merge_requires_expected_head_sha, true);
  assert.equal(policy.merge.repository_ruleset_bypass, false);
  assert.equal(policy.merge.force_merge, false);
  assert.equal(policy.merge.merge_authorizes_live_mutation, false);
  assert.equal(
    policy.platform_constraints.native_auto_merge_only_applies_when_pull_request_cannot_merge_immediately,
    true,
  );
});

test("Control production and trust-boundary mutations stay outside FULL", () => {
  const policy = readPolicy();

  assert.equal(policy.live.auto_run_full_command_is_live_authority, false);
  assert.equal(policy.live.separate_explicit_owner_live_authorization_required, true);
  assert.equal(
    policy.live.state_when_definition_of_done_requires_unapproved_strict_live,
    "PAUSED_OWNER_LIVE_GATE",
  );

  for (const forbidden of [
    "PRODUCTION_WORKER_UPLOAD_DEPLOY_OR_PROMOTION",
    "PRODUCTION_D1_DATA_MUTATION",
    "QUEUE_WRITE_REPLAY_OR_CONFIGURATION_MUTATION",
    "LIVE_CONTROL_MERGE_NEEDS_CHANGES_LATER_OR_OTHER_DECISION_ACTION",
    "GITHUB_APP_PERMISSION_OR_REPOSITORY_SELECTION_CHANGE",
    "CLOUDFLARE_DNS_ACCESS_TUNNEL_DOMAIN_BINDING_OR_INFRASTRUCTURE_MUTATION",
    "SECRET_CREDENTIAL_OR_TOKEN_CHANGE",
    "RPI5_ROOT_SUDO_SYSTEMD_DOCKER_NETWORK_OR_HOST_MUTATION",
  ]) {
    assert.ok(policy.strict_live_never_implied.includes(forbidden));
  }
});

test("resume and completion remain bounded by current platform limits", () => {
  const policy = readPolicy();

  assert.equal(
    policy.execution_model.primary_resume,
    "CHATGPT_WORK_GITHUB_EVENT_TRIGGERED_TASK",
  );
  assert.equal(policy.execution_model.fallback_watchdog, "CHATGPT_PLUS_SCHEDULED_TASK");
  assert.equal(policy.execution_model.event_triggered_work_required_for_correctness, false);
  assert.equal(policy.execution_model.scheduled_watchdog_max_frequency, "PT1H");
  assert.equal(policy.execution_model.event_triggered_task_max_runs_per_hour, 30);
  assert.equal(policy.execution_model.event_triggered_task_max_runs_per_day, 720);
  assert.equal(policy.platform_constraints.scheduled_tasks_active_limit_plus, 5);
  assert.equal(policy.completion.post_merge_exact_main_verification_required, true);
  assert.equal(
    policy.completion.post_merge_exact_main_ci_required_when_repository_ci_runs_on_push,
    true,
  );
  assert.equal(policy.completion.controller_returns_to_idle_on_done, true);
});
