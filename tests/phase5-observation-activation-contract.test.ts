import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CONTRACT_PATH = ".github/phase5-rpi5-observation-activation-contract.json";
const DOC_PATH = "docs/PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md";
const OPERATOR_PATH = "docs/PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md";
const CHECKPOINT_PATH = "docs/ROADMAP_CURRENT_CHECKPOINT.md";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

type MigrationCase = {
  when: Record<string, string>;
  result: string;
  exact_ordered_migrations: string[];
};

type MutationClass = {
  requires_separate_owner_live_authorization: boolean;
  [key: string]: unknown;
};

type ActivationContract = {
  schema_version: number;
  contract: string;
  authority: {
    source_contract_only: boolean;
    live_authority_granted: boolean;
    merge_authorizes_live: boolean;
    cross_class_cascade: boolean;
    authorization_consumed_at: string;
    on_error_timeout_drift_or_ambiguity_after_mutation: string;
  };
  preflight: {
    workflow: string;
    required_result: string;
    requires_exact_current_main: boolean;
    requires_successful_exact_main_ci: boolean;
    requires_dormant_ingest: boolean;
    required_zero_mutation_markers: string[];
  };
  migration_ceiling: {
    ordered_source_migrations: string[];
    valid_classifications: MigrationCase[];
    otherwise: string;
  };
  mutation_classes: Record<string, MutationClass>;
  future_owner_command_templates: Record<string, string>;
  explicit_forbidden: string[];
};

const contract = JSON.parse(source(CONTRACT_PATH)) as ActivationContract;

const allMigrations = [
  "0010_webhook_observability_hot_index.sql",
  "0011_rpi5_observation_replay_claims.sql",
  "0012_rpi5_production_visibility_projection.sql",
  "0013_rpi5_observation_atomic_acceptance.sql",
];

test("Phase 5 activation machine contract grants source authority only", () => {
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.contract, "PHASE5_RPI5_OBSERVATION_ACTIVATION_V1");
  assert.equal(contract.authority.source_contract_only, true);
  assert.equal(contract.authority.live_authority_granted, false);
  assert.equal(contract.authority.merge_authorizes_live, false);
  assert.equal(contract.authority.cross_class_cascade, false);
  assert.equal(contract.authority.authorization_consumed_at, "FIRST_AUTHORIZED_MUTATION");
  assert.equal(
    contract.authority.on_error_timeout_drift_or_ambiguity_after_mutation,
    "STOP_NO_RETRY_ROLLBACK_OR_ALTERNATE_MUTATION",
  );
});

test("activation requires exact-main readonly preflight and complete zero-mutation receipt", () => {
  assert.equal(contract.preflight.workflow, ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml");
  assert.equal(contract.preflight.required_result, "PHASE5_RPI5_OBSERVATION_PREFLIGHT=PASS");
  assert.equal(contract.preflight.requires_exact_current_main, true);
  assert.equal(contract.preflight.requires_successful_exact_main_ci, true);
  assert.equal(contract.preflight.requires_dormant_ingest, true);
  assert.deepEqual(contract.preflight.required_zero_mutation_markers, [
    "RPI5_REQUEST=NO",
    "QUEUE_MUTATION=NO",
    "REMOTE_D1_MUTATION=NO",
    "WORKER_MUTATION=NO",
    "CLOUDFLARE_CONFIG_MUTATION=NO",
    "SECRET_MUTATION=NO",
    "CLOUDFLARE_MUTATION=NO",
    "LIVE_AUTHORIZATION=NOT_GRANTED",
  ]);
});

test("migration ceiling permits only coherent exact ordered apply sets", () => {
  assert.deepEqual(contract.migration_ceiling.ordered_source_migrations, allMigrations);
  assert.equal(contract.migration_ceiling.otherwise, "STOP_UNKNOWN_PARTIAL_CONTRADICTORY_OR_DRIFTED_STATE");
  assert.equal(contract.migration_ceiling.valid_classifications.length, 3);

  const [allAbsent, predecessorPresent, allPresent] = contract.migration_ceiling.valid_classifications;
  assert.deepEqual(allAbsent.exact_ordered_migrations, allMigrations);
  assert.deepEqual(predecessorPresent.exact_ordered_migrations, allMigrations.slice(1));
  assert.deepEqual(allPresent.exact_ordered_migrations, []);
  assert.equal(allPresent.result, "NO_D1_APPLY_REQUIRED");

  assert.deepEqual(allAbsent.when, {
    D1_0010_MIGRATION: "ABSENT",
    D1_0010_INDEX: "ABSENT_CONSISTENT",
    D1_PHASE5_MIGRATIONS: "ABSENT",
    D1_PHASE5_SCHEMA: "ABSENT_CONSISTENT",
  });
  assert.deepEqual(predecessorPresent.when, {
    D1_0010_MIGRATION: "PRESENT",
    D1_0010_INDEX: "PRESENT_VALID",
    D1_PHASE5_MIGRATIONS: "ABSENT",
    D1_PHASE5_SCHEMA: "ABSENT_CONSISTENT",
  });
  assert.deepEqual(allPresent.when, {
    D1_0010_MIGRATION: "PRESENT",
    D1_0010_INDEX: "PRESENT_VALID",
    D1_PHASE5_MIGRATIONS: "PRESENT",
    D1_PHASE5_SCHEMA: "PRESENT_VALID",
  });
});

test("D1, key, Worker and RPi5 mutation classes stay separately owner-gated", () => {
  assert.deepEqual(Object.keys(contract.mutation_classes), [
    "D1_APPLY",
    "VERIFICATION_KEY_PROVISION",
    "WORKER_ACTIVATE",
    "RPI5_SIGNER_RUNTIME",
  ]);

  for (const mutationClass of Object.values(contract.mutation_classes)) {
    assert.equal(mutationClass.requires_separate_owner_live_authorization, true);
  }

  for (const name of ["D1_APPLY", "VERIFICATION_KEY_PROVISION", "WORKER_ACTIVATE"]) {
    assert.equal(contract.mutation_classes[name].requires_exact_source_sha, true);
    assert.equal(contract.mutation_classes[name].requires_exact_preflight_run, true);
    assert.equal(contract.mutation_classes[name].requires_expected_remote_state_match, true);
  }

  assert.equal(contract.mutation_classes.VERIFICATION_KEY_PROVISION.secret_value_in_command_repo_logs_or_receipt, false);
  assert.equal(contract.mutation_classes.RPI5_SIGNER_RUNTIME.authority_owner, "RPi5_main");
  assert.equal(contract.mutation_classes.RPI5_SIGNER_RUNTIME.direct_control_ssh_sudo_root_or_protected_host_path, false);
  assert.equal(contract.mutation_classes.RPI5_SIGNER_RUNTIME.requires_exact_control_source_sha, true);
  assert.equal(contract.mutation_classes.RPI5_SIGNER_RUNTIME.requires_expected_control_worker_state, true);

  const d1 = contract.mutation_classes.D1_APPLY;
  assert.equal(d1.executor_workflow, ".github/workflows/phase5-rpi5-observation-d1-live.yml");
  assert.equal(d1.requires_exact_ci_run, true);
  assert.equal(d1.requires_exact_worker_deployment, true);
  assert.equal(d1.requires_exact_worker_version, true);
  assert.equal(d1.requires_full_remote_migration_history_match, true);
  assert.equal(d1.workers_read_secret_binding, "CLOUDFLARE_API_TOKEN");
  assert.equal(d1.d1_read_secret_binding, "CLOUDFLARE_D1_READ_TOKEN");
  assert.equal(d1.d1_write_secret_binding, "CLOUDFLARE_D1_WRITE_TOKEN");
  assert.equal(d1.prewrite_history_rule, "REMOTE_HISTORY_EQUALS_SOURCE_PREFIX_BEFORE_EXACT_AUTHORIZED_CEILING");
});

test("future command templates are narrow documentation, not embedded secret material", () => {
  assert.deepEqual(Object.keys(contract.future_owner_command_templates), [
    "D1_APPLY",
    "VERIFICATION_KEY_PROVISION",
    "WORKER_ACTIVATE",
    "RPI5_SIGNER_RUNTIME",
  ]);

  for (const command of Object.values(contract.future_owner_command_templates)) {
    assert.match(command, /^AUTHORIZE LIVE PHASE5 /);
    assert.match(command, /<[^>]+>/);
    assert.doesNotMatch(command, /PRIVATE[_ -]?KEY[_ -]?VALUE|SECRET[_ -]?VALUE|TOKEN=/i);
  }
});

test("contract forbids authority inheritance, protected-host shortcuts and automatic recovery", () => {
  for (const required of [
    "SECRET_OR_PRIVATE_KEY_VALUE_IN_SOURCE_COMMAND_LOG_OR_PUBLIC_RECEIPT",
    "DIRECT_CONTROL_SSH_SUDO_ROOT_OR_PROTECTED_HOST_INSPECTION",
    "QUEUE_MUTATION_UNLESS_SEPARATELY_DECLARED_AND_AUTHORIZED",
    "CROSS_CLASS_AUTOMATIC_CASCADE",
    "MERGE_TO_DEPLOY_AUTHORITY_INHERITANCE",
    "HISTORICAL_AUTHORIZATION_REPLAY",
    "AUTO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION_AFTER_ERROR",
  ]) {
    assert.ok(contract.explicit_forbidden.includes(required));
  }
});

test("operator activation doc keeps the fresh evidence and non-authority boundaries explicit", () => {
  const text = source(DOC_PATH);

  for (const required of [
    "EXACT_D1_MIGRATION_CEILING",
    "SOURCE_READY_LIVE_UNPROVEN",
    "READONLY_PREFLIGHT_EVIDENCE_ONLY",
    "MERGE_NOT_DEPLOY_AUTHORITY",
    "0010_webhook_observability_hot_index.sql",
    "0011_rpi5_observation_replay_claims.sql",
    "0012_rpi5_production_visibility_projection.sql",
    "0013_rpi5_observation_atomic_acceptance.sql",
    "STOP_UNKNOWN_PARTIAL_CONTRADICTORY_OR_DRIFTED_STATE",
    "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS",
    "RPi5_main",
    "phase5-rpi5-observation-d1-live.yml",
    "CLOUDFLARE_D1_WRITE_TOKEN",
    "APPLY_STARTED=YES",
    "0001` through `0009",
  ]) {
    assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(text, /all four migrations absent/i);
  assert.match(text, /not durable production truth/i);
  assert.match(text, /never cascade automatically/i);
  assert.match(text, /consume the authorization when the first authorized mutation starts/i);
  assert.match(text, /do not retry, rollback, clean up or choose an alternate mutation/i);
});

test("durable operator and checkpoint docs converge on the hardened ceiling contract", () => {
  for (const path of [OPERATOR_PATH, CHECKPOINT_PATH]) {
    const text = source(path);
    assert.match(text, /PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT\.md/);
    assert.match(text, /0010_webhook_observability_hot_index\.sql/);
    assert.match(text, /idx_webhook_deliveries_active_updated_delivery/);
    assert.match(text, /MERGE_NOT_DEPLOY_AUTHORITY/);
  }

  assert.match(source(OPERATOR_PATH), /PR #599/);
  assert.match(source(OPERATOR_PATH), /D1_0010_MIGRATION/);
  assert.match(source(OPERATOR_PATH), /D1_0010_INDEX/);
  assert.match(source(CHECKPOINT_PATH), /EXACT_D1_MIGRATION_CEILING/);
  assert.match(source(CHECKPOINT_PATH), /three planning outcomes/i);
});
