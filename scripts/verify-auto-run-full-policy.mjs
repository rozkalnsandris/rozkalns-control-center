import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const literal = (value) => ({ kind: "literal", value });
const boolean = () => ({ kind: "boolean" });
const integer = (options = {}) => ({ kind: "integer", ...options });
const string = (options = {}) => ({ kind: "string", ...options });
const object = (properties) => ({ kind: "object", properties });
const stringSet = (values) => ({ kind: "stringSet", values });
const tuple = (items) => ({ kind: "tuple", items });

const AUTO_RUN_STATES = [
  "IDLE",
  "ACTIVATING",
  "WORKING",
  "WAITING_CI",
  "WAITING_REVIEW",
  "CORRECTING",
  "WAITING_EVENT_RESUME",
  "WAITING_WATCHDOG_RESUME",
  "PAUSED_USAGE",
  "PAUSED_PLATFORM_APPROVAL",
  "PAUSED_EXTERNAL",
  "PAUSED_OWNER_LIVE_GATE",
  "VERIFYING",
  "DONE",
  "STOP_SCOPE_OR_RISK",
  "STOP_ERROR",
];

const schema = object({
  schema_version: literal(5),
  policy: literal("AUTO-RUN FULL v2"),
  repository: literal("rozkalnsandris/rozkalns-control-center"),
  enablement_issue: literal(498),
  controller_issue: literal(499),
  lane_role: object({
    normal_implementation_lane: literal("AUTO-RUN FULL"),
    safe_discovery_lane: literal("FAST-LANE v2.2"),
    fast_lane_may_infer_auto_run_full: literal(false),
  }),
  command: object({
    canonical_prefix: literal("AUTO-RUN FULL"),
    syntax: literal("AUTO-RUN FULL rozkalns-control-center #<issue>"),
    requires_explicit_current_command: literal(true),
    requires_exact_repository: literal(true),
    requires_exact_open_issue: literal(true),
    may_be_inferred_from_context: literal(false),
    single_command_is_owner_source_and_merge_authorization: literal(true),
    single_command_is_live_authorization: literal(false),
  }),
  execution_model: object({
    canonical_state: literal("GITHUB"),
    one_active_issue_at_a_time: literal(true),
    chat_history_is_authority: literal(false),
    primary_resume: literal("CHATGPT_WORK_GITHUB_EVENT_TRIGGERED_TASK"),
    fallback_watchdog: literal("CHATGPT_PLUS_SCHEDULED_TASK"),
    event_triggered_work_primary: literal(true),
    event_triggered_work_required_for_correctness: literal(false),
    scheduled_watchdog_max_frequency: string({ pattern: /^PT[1-9][0-9]*H$/ }),
    event_triggered_task_max_runs_per_hour: integer({ min: 1 }),
    event_triggered_task_max_runs_per_day: integer({ min: 1 }),
    session_end_is_resumable: literal(true),
    manual_turpini_is_resume_only: literal(true),
  }),
  activation: object({
    fresh_reads_required: stringSet([
      "issue_1_master_contract",
      "issue_278_canonical_operational_handoff",
      "AGENTS.md",
      ".github/start-mode-routing.json",
      ".github/auto-run-full-v2.json",
      "target_issue",
      "current_main",
      "active_pr_ci_review_state",
      "relevant_dependencies",
      "controller_issue_499",
    ]),
    preferred_write_order: tuple([
      literal("AUTHORIZATION_RECEIPT"),
      literal("POST_RECEIPT_MAIN_REVALIDATION"),
      literal("CONTROLLER_ACTIVATION"),
      literal("SOURCE_WORK"),
    ]),
    materialize_owner_auth_on_target_issue: literal(true),
    activation_comment_schema: literal("rozkalns.auto-run-full-authorization.v2"),
    activation_must_freeze: stringSet([
      "repository",
      "issue_number",
      "issue_definition_of_done",
      "activation_main_sha",
      "allowed_source_actions",
      "merge_authority",
      "retry_semantics",
      "explicit_live_exclusions",
    ]),
    authorization_receipt_required_before: stringSet([
      "CONTROLLER_ACTIVE_POINTER_WRITE",
      "BRANCH_CREATE",
      "SOURCE_FILE_WRITE",
      "COMMIT_OR_PUSH",
      "PR_CREATE_OR_UPDATE",
      "MERGE",
      "RUNTIME_OR_LIVE_MUTATION",
    ]),
    stable_receipt_required_before: stringSet([
      "CONTROLLER_WORKING_POINTER_WRITE",
      "BRANCH_CREATE",
      "SOURCE_FILE_WRITE",
      "COMMIT_OR_PUSH",
      "PR_CREATE_OR_UPDATE",
      "MERGE",
      "RUNTIME_OR_LIVE_MUTATION",
    ]),
    post_receipt_main_revalidation_required: literal(true),
    post_receipt_main_stability: object({
      barrier: literal("READ_MAIN_M0__WRITE_RECEIPT_M0__READ_MAIN_M1__REQUIRE_M1_EQUALS_M0"),
      stable_when: literal("POST_WRITE_MAIN_SHA_EQUALS_RECEIPT_ACTIVATION_MAIN_SHA"),
      only_latest_stable_receipt_is_authoritative_for_source_and_merge: literal(true),
      stale_receipt_never_authorizes_source_or_merge: literal(true),
      main_only_drift_consumes_owner_authorization: literal(false),
      main_only_drift_requires_new_owner_command: literal(false),
      max_consecutive_inline_stabilization_attempts: literal(3),
      after_attempt_limit_state: literal("PAUSED_EXTERNAL"),
      paused_controller_pointer_allowed_after_receipt: literal(true),
      paused_controller_pointer_is_source_authority: literal(false),
      resume_must_establish_stable_receipt_before_source: literal(true),
      scope_or_rule_drift_is_not_main_only_drift: literal(true),
    }),
    main_drift_before_source_recovery: object({
      allowed: literal(true),
      requires_no_branch_source_commit_pr_merge_runtime_or_live_mutation: literal(true),
      requires_fresh_revalidation: stringSet([
        "exact_target_issue_is_still_open",
        "target_issue_scope_is_identical_to_frozen_scope",
        "repository_rules_and_policy_are_compatible_with_frozen_scope",
        "controller_points_to_no_other_issue",
        "no_branch_source_commit_pr_merge_runtime_or_live_mutation_occurred",
        "current_main_active_pr_ci_review_and_dependencies_are_freshly_re_read",
      ]),
      old_receipt_is_immutable_audit_record: literal(true),
      old_receipt_must_not_be_deleted_or_edited: literal(true),
      superseding_receipt_required: literal(true),
      supersession_reason: literal("MAIN_DRIFT_BEFORE_SOURCE"),
      superseding_receipt_must_preserve_frozen_scope: literal(true),
      latest_superseding_receipt_must_pass_post_write_main_revalidation: literal(true),
      mismatch_after_prohibited_mutation_requires_stop: literal(true),
    }),
    later_issue_edits_do_not_expand_authority: literal(true),
    new_scope_requires_stop: literal(true),
  }),
  allowed_without_further_owner_nudge: stringSet([
    "FRESH_GITHUB_READS",
    "SOURCE_ANALYSIS",
    "SOURCE_DOC_TEST_POLICY_CHANGES",
    "BRANCH_CREATE",
    "EXACT_PATH_COMMITS",
    "PUSH",
    "PR_CREATE_OR_UPDATE",
    "CI_WAIT_AND_INSPECTION",
    "REVIEW_INGESTION",
    "SCOPE_PRESERVING_CORRECTIVE_COMMITS",
    "MERGE_CONFLICT_RESOLUTION_WITHOUT_HISTORY_REWRITE",
    "FINAL_EXACT_HEAD_REVIEW",
    "ARM_NATIVE_AUTO_MERGE_ONLY_WHEN_HEAD_IS_FROZEN_AND_REQUIRED_GATES_ARE_STILL_PENDING",
    "DIRECT_EXACT_HEAD_SQUASH_MERGE_WHEN_PR_IS_ALREADY_IMMEDIATELY_MERGEABLE",
    "POST_MERGE_READ_ONLY_REVALIDATION",
    "FINAL_GITHUB_RECEIPTS",
  ]),
  strict_live_never_implied: stringSet([
    "PRODUCTION_WORKER_UPLOAD_DEPLOY_OR_PROMOTION",
    "PRODUCTION_DATABASE_WRITE_OR_MIGRATION",
    "PRODUCTION_D1_DATA_MUTATION",
    "QUEUE_WRITE_REPLAY_OR_CONFIGURATION_MUTATION",
    "LIVE_CONTROL_MERGE_NEEDS_CHANGES_LATER_OR_OTHER_DECISION_ACTION",
    "LIVE_CONTROL_CANARY_OR_EXECUTOR_INVOCATION_WITH_WRITE_EFFECTS",
    "GITHUB_APP_PERMISSION_OR_REPOSITORY_SELECTION_CHANGE",
    "GITHUB_REPOSITORY_SETTINGS_RULESET_OR_BRANCH_PROTECTION_CHANGE",
    "CLOUDFLARE_DNS_ACCESS_TUNNEL_DOMAIN_BINDING_OR_INFRASTRUCTURE_MUTATION",
    "SECRET_CREDENTIAL_OR_TOKEN_CHANGE",
    "RPI5_ROOT_SUDO_SYSTEMD_DOCKER_NETWORK_OR_HOST_MUTATION",
    "DESTRUCTIVE_CLEANUP",
    "UNDECLARED_RETRY_ROLLBACK_OR_ALTERNATE_MUTATION_PATH",
  ]),
  never_implied: stringSet([
    "UNRELATED_ISSUE_OR_REPOSITORY_WORK",
    "RESET_REBASE_FORCE_OR_HISTORY_REWRITE",
    "PROVIDER_API_KEY",
    "TOKEN_BILLED_LLM_FALLBACK",
    "AUTOMATIC_PAID_CREDIT_PURCHASE",
  ]),
  merge: object({
    auto_run_full_command_is_explicit_owner_merge_authority_for_the_frozen_issue: literal(true),
    strategy: literal("HYBRID_EXACT_HEAD_V2"),
    canonical_pr_only: literal(true),
    canonical_pr_must_close_exact_target_issue: literal(true),
    canonical_pr_closing_reference_format: literal("Closes #<target_issue>"),
    canonical_pr_closing_reference_must_match_frozen_issue: literal(true),
    source_head_must_be_frozen_before_any_merge_mechanism: literal(true),
    fresh_exact_head_revalidation_required: literal(true),
    final_diff_scope_review_required: literal(true),
    required_ci_and_review_policy_must_be_fresh: literal(true),
    unresolved_actionable_review_findings_must_be_zero_before_direct_merge: literal(true),
    mergeability_must_be_fresh: literal(true),
    changed_head_invalidates_previous_merge_readiness: literal(true),
    when_immediately_mergeable: literal("DIRECT_SQUASH_WITH_EXPECTED_HEAD_SHA"),
    when_blocked_only_by_required_gates_and_head_is_frozen: literal("ENABLE_GITHUB_AUTO_MERGE_IF_REPOSITORY_CAPABILITY_AVAILABLE"),
    native_auto_merge_is_not_attempted_for_already_clean_immediately_mergeable_pr: literal(true),
    native_auto_merge_must_not_be_armed_while_source_corrections_remain_possible: literal(true),
    source_push_after_native_auto_merge_arm: literal(false),
    correction_after_native_auto_merge_arm_requires_disable_before_push: literal(true),
    if_safe_auto_merge_disable_is_unavailable_or_ambiguous: literal("STOP_ERROR"),
    direct_merge_requires_expected_head_sha: literal(true),
    repository_ruleset_bypass: literal(false),
    force_merge: literal(false),
    merge_authorizes_live_mutation: literal(false),
  }),
  live: object({
    auto_run_full_command_is_live_authority: literal(false),
    separate_explicit_owner_live_authorization_required: literal(true),
    existing_issue_1_issue_278_and_phase_specific_live_contracts_remain_authoritative: literal(true),
    source_work_may_converge_before_live_gate: literal(true),
    state_when_definition_of_done_requires_unapproved_strict_live: literal("PAUSED_OWNER_LIVE_GATE"),
    new_live_mutation_class_after_activation: literal("STOP_SCOPE_OR_RISK"),
    post_live_mutation_error_without_predeclared_recovery: literal("STOP_ERROR"),
  }),
  states: stringSet(AUTO_RUN_STATES),
  continuation: object({
    routine_ci_failure_is_owner_gate: literal(false),
    review_finding_is_owner_gate: literal(false),
    ordinary_merge_conflict_is_owner_gate: literal(false),
    session_or_turn_end_is_owner_gate: literal(false),
    event_triggered_run_reconstructs_from_github: literal(true),
    scheduled_watchdog_reconstructs_from_github: literal(true),
    usage_exhaustion: literal("PAUSED_USAGE"),
    platform_required_app_approval: literal("PAUSED_PLATFORM_APPROVAL"),
    external_wait: literal("PAUSED_EXTERNAL"),
    identical_failure_retry_ceiling: literal(3),
    retry_requires_materially_new_hypothesis_after_repeat: literal(true),
  }),
  completion: object({
    source_only_normal_terminal_state: literal("DONE"),
    target_issue_definition_of_done_must_be_satisfied: literal(true),
    post_merge_exact_main_verification_required: literal(true),
    post_merge_exact_main_ci_required_when_repository_ci_runs_on_push: literal(true),
    post_merge_target_issue_state_revalidation_required: literal(true),
    target_issue_must_be_closed_before_done: literal(true),
    target_issue_closure_mechanism: literal("CANONICAL_PR_GITHUB_CLOSING_KEYWORD_ON_MERGE"),
    controller_must_not_return_to_idle_while_target_issue_is_open: literal(true),
    open_target_after_merged_pr_state: literal("STOP_ERROR"),
    final_github_receipt_required: literal(true),
    controller_returns_to_idle_on_done: literal(true),
    strict_live_required_but_not_authorized_is_not_done: literal(true),
  }),
  billing: object({
    primary_product: literal("CHATGPT_PLUS"),
    provider_api_keys_allowed: literal(false),
    automatic_paid_credits_allowed: literal(false),
    codex_required: literal(false),
    copilot_required: literal(false),
  }),
  platform_constraints: object({
    scheduled_tasks_active_limit_plus: integer({ min: 1 }),
    scheduled_tasks_paid_plan_max_frequency: string({ pattern: /^PT[1-9][0-9]*H$/ }),
    event_triggered_tasks_max_runs_per_hour: integer({ min: 1 }),
    event_triggered_tasks_max_runs_per_day: integer({ min: 1 }),
    github_event_triggered_work_supported_for_pull_request_activity: boolean(),
    connected_app_approval_may_pause_task: boolean(),
    repository_provider_permissions_still_apply: literal(true),
    repository_allow_auto_merge_setting_must_be_enabled_for_native_auto_merge: literal(true),
    native_auto_merge_only_applies_when_pull_request_cannot_merge_immediately: literal(true),
    event_triggered_work_is_optional_for_correctness: literal(true),
  }),
});

function fail(path, message) {
  throw new Error(`AUTO_RUN_FULL_POLICY_INVALID ${path}: ${message}`);
}

function validateStringSet(value, expected, path) {
  if (!Array.isArray(value)) {
    fail(path, "expected array");
  }

  const actual = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      fail(`${path}[${index}]`, "expected string");
    }
    actual.push(item);
  }

  if (new Set(actual).size !== actual.length) {
    fail(path, "duplicate array item");
  }

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((item) => !actualSet.has(item));
  const unknown = actual.filter((item) => !expectedSet.has(item));

  if (missing.length > 0) {
    fail(path, `missing required items: ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    fail(path, `unknown items: ${unknown.join(", ")}`);
  }
}

function validateNode(value, node, path) {
  switch (node.kind) {
    case "literal":
      if (!Object.is(value, node.value)) {
        fail(path, `expected ${JSON.stringify(node.value)}, got ${JSON.stringify(value)}`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        fail(path, "expected boolean");
      }
      return;
    case "integer":
      if (!Number.isInteger(value)) {
        fail(path, "expected integer");
      }
      if (node.min !== undefined && value < node.min) {
        fail(path, `expected integer >= ${node.min}`);
      }
      if (node.max !== undefined && value > node.max) {
        fail(path, `expected integer <= ${node.max}`);
      }
      return;
    case "string":
      if (typeof value !== "string") {
        fail(path, "expected string");
      }
      if (node.pattern && !node.pattern.test(value)) {
        fail(path, `value does not match ${node.pattern}`);
      }
      return;
    case "stringSet":
      validateStringSet(value, node.values, path);
      return;
    case "tuple":
      if (!Array.isArray(value)) {
        fail(path, "expected array");
      }
      if (value.length !== node.items.length) {
        fail(path, `expected ${node.items.length} items, got ${value.length}`);
      }
      for (let index = 0; index < node.items.length; index += 1) {
        validateNode(value[index], node.items[index], `${path}[${index}]`);
      }
      return;
    case "object": {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      ) {
        fail(path, "expected plain object");
      }

      const actualKeys = Reflect.ownKeys(value);
      const expectedKeys = Object.keys(node.properties);
      const symbolKeys = actualKeys.filter((key) => typeof key !== "string");
      if (symbolKeys.length > 0) {
        fail(path, "symbol keys are not allowed");
      }

      const actualStringKeys = actualKeys;
      const expectedKeySet = new Set(expectedKeys);
      const actualKeySet = new Set(actualStringKeys);
      const missing = expectedKeys.filter((key) => !actualKeySet.has(key));
      const unknown = actualStringKeys.filter((key) => !expectedKeySet.has(key));

      if (missing.length > 0) {
        fail(path, `missing required fields: ${missing.join(", ")}`);
      }
      if (unknown.length > 0) {
        fail(path, `unknown fields: ${unknown.join(", ")}`);
      }

      for (const key of expectedKeys) {
        validateNode(value[key], node.properties[key], `${path}.${key}`);
      }
      return;
    }
    default:
      fail(path, `unknown validator node ${String(node.kind)}`);
  }
}

function validateCrossFieldInvariants(policy) {
  if (
    policy.execution_model.scheduled_watchdog_max_frequency !==
    policy.platform_constraints.scheduled_tasks_paid_plan_max_frequency
  ) {
    fail(
      "$.platform_constraints.scheduled_tasks_paid_plan_max_frequency",
      "must equal execution_model.scheduled_watchdog_max_frequency",
    );
  }

  if (
    policy.execution_model.event_triggered_task_max_runs_per_hour !==
    policy.platform_constraints.event_triggered_tasks_max_runs_per_hour
  ) {
    fail(
      "$.platform_constraints.event_triggered_tasks_max_runs_per_hour",
      "must equal execution_model.event_triggered_task_max_runs_per_hour",
    );
  }

  if (
    policy.execution_model.event_triggered_task_max_runs_per_day !==
    policy.platform_constraints.event_triggered_tasks_max_runs_per_day
  ) {
    fail(
      "$.platform_constraints.event_triggered_tasks_max_runs_per_day",
      "must equal execution_model.event_triggered_task_max_runs_per_day",
    );
  }

  const states = new Set(policy.states);
  for (const [path, state] of [
    ["$.activation.post_receipt_main_stability.after_attempt_limit_state", policy.activation.post_receipt_main_stability.after_attempt_limit_state],
    ["$.merge.if_safe_auto_merge_disable_is_unavailable_or_ambiguous", policy.merge.if_safe_auto_merge_disable_is_unavailable_or_ambiguous],
    ["$.live.state_when_definition_of_done_requires_unapproved_strict_live", policy.live.state_when_definition_of_done_requires_unapproved_strict_live],
    ["$.live.new_live_mutation_class_after_activation", policy.live.new_live_mutation_class_after_activation],
    ["$.live.post_live_mutation_error_without_predeclared_recovery", policy.live.post_live_mutation_error_without_predeclared_recovery],
    ["$.continuation.usage_exhaustion", policy.continuation.usage_exhaustion],
    ["$.continuation.platform_required_app_approval", policy.continuation.platform_required_app_approval],
    ["$.continuation.external_wait", policy.continuation.external_wait],
    ["$.completion.source_only_normal_terminal_state", policy.completion.source_only_normal_terminal_state],
    ["$.completion.open_target_after_merged_pr_state", policy.completion.open_target_after_merged_pr_state],
  ]) {
    if (!states.has(state)) {
      fail(path, `references unknown state ${JSON.stringify(state)}`);
    }
  }
}

export function validateAutoRunFullPolicy(policy) {
  validateNode(policy, schema, "$");
  validateCrossFieldInvariants(policy);
  return policy;
}

export function readAndValidateAutoRunFullPolicy(
  path = ".github/auto-run-full-v2.json",
) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("$", `cannot parse ${path}: ${message}`);
  }
  return validateAutoRunFullPolicy(parsed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readAndValidateAutoRunFullPolicy();
  process.stdout.write("AUTO-RUN FULL policy validation PASS\n");
}
