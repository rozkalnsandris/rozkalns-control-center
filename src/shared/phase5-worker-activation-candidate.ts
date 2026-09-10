export const PHASE5_WORKER_ACTIVATION_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const PHASE5_WORKER_ACTIVATION_CANDIDATE_CONTRACT =
  "PHASE5_RPI5_OBSERVATION_WORKER_ACTIVATION_CANDIDATE_V1" as const;
export const PHASE5_WORKER_ACTIVATION_REPOSITORY =
  "rozkalnsandris/rozkalns-control-center" as const;
export const PHASE5_WORKER_ACTIVATION_WORKER = "rozkalns-control" as const;
export const PHASE5_WORKER_ACTIVATION_NODE_VERSION = "24.19.0" as const;
export const PHASE5_WORKER_ACTIVATION_WRANGLER_VERSION = "4.120.0" as const;
export const PHASE5_WORKER_ACTIVATION_INGEST_BINDING =
  "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED" as const;
export const PHASE5_WORKER_ACTIVATION_VERIFICATION_KEY_BINDING =
  "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS" as const;
export const PHASE5_WORKER_ACTIVATION_D1_BINDING = "CONTROL_DB" as const;
export const PHASE5_WORKER_ACTIVATION_D1_DATABASE_ID =
  "8504e986-faf0-450c-bfb5-41b5dbf8be09" as const;

export const PHASE5_WORKER_ACTIVATION_ALLOWED_DELTAS = [
  "CREATE_ONE_NEW_WORKER_VERSION_FROM_EXACT_SOURCE_AND_CANDIDATE_CONFIG",
  "ADD_OR_SET_CONTROL_RPI5_OBSERVATION_INGEST_ENABLED_TO_PLAIN_TEXT_TRUE",
  "DEPLOY_ONLY_THE_EXACT_VERIFIED_UPLOADED_VERSION_AT_100_PERCENT",
] as const;

export const PHASE5_WORKER_ACTIVATION_FORBIDDEN_DELTAS = [
  "VERIFICATION_KEY_BINDING_OR_VALUE_CHANGE",
  "CONTROL_DB_BINDING_OR_RESOURCE_CHANGE",
  "NON_TARGET_BINDING_CHANGE",
  "ROUTE_OR_CUSTOM_DOMAIN_CHANGE",
  "TRIGGER_OR_QUEUE_CHANGE",
  "D1_MUTATION",
  "SECRET_OR_CREDENTIAL_MUTATION",
  "CLOUDFLARE_ACCOUNT_OR_ACCESS_DNS_TUNNEL_CHANGE",
  "RPI5_MUTATION",
  "CROSS_CLASS_CASCADE",
] as const;

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type Phase5WorkerActivationIngestBindingState = "ABSENT" | "PRESENT_FALSE";

export interface Phase5WorkerActivationCandidateManifest {
  readonly schema_version: typeof PHASE5_WORKER_ACTIVATION_CANDIDATE_SCHEMA_VERSION;
  readonly contract: typeof PHASE5_WORKER_ACTIVATION_CANDIDATE_CONTRACT;
  readonly repository: typeof PHASE5_WORKER_ACTIVATION_REPOSITORY;
  readonly worker: typeof PHASE5_WORKER_ACTIVATION_WORKER;
  readonly source_sha: string;
  readonly ci_run_id: string;
  readonly preflight_run_id: string;
  readonly source_config_sha256: string;
  readonly toolchain: {
    readonly node_version: typeof PHASE5_WORKER_ACTIVATION_NODE_VERSION;
    readonly wrangler_version: typeof PHASE5_WORKER_ACTIVATION_WRANGLER_VERSION;
  };
  readonly expected_current: {
    readonly deployment_id: string;
    readonly version_id: string;
    readonly traffic_percent: 100;
    readonly ingest_binding_state: Phase5WorkerActivationIngestBindingState;
    readonly verification_key_prerequisite: {
      readonly binding: typeof PHASE5_WORKER_ACTIVATION_VERIFICATION_KEY_BINDING;
      readonly type: "secret_text";
      readonly state: "PRESENT_PROTECTED";
      readonly key_id: string;
      readonly provision_run_id: string;
      readonly value_observed: false;
    };
    readonly d1_prerequisite: {
      readonly binding: typeof PHASE5_WORKER_ACTIVATION_D1_BINDING;
      readonly database_id: typeof PHASE5_WORKER_ACTIVATION_D1_DATABASE_ID;
      readonly migration_state: "PRESENT_VALID_0010_THROUGH_0013";
    };
    readonly non_target_bindings_sha256: string;
  };
  readonly intended_result: {
    readonly version_strategy: "UPLOAD_NEW_VERSION_THEN_DEPLOY_EXACT_VERSION_100_PERCENT";
    readonly ingest_binding: {
      readonly name: typeof PHASE5_WORKER_ACTIVATION_INGEST_BINDING;
      readonly type: "plain_text";
      readonly value: "true";
    };
    readonly verification_key_binding: {
      readonly name: typeof PHASE5_WORKER_ACTIVATION_VERIFICATION_KEY_BINDING;
      readonly type: "secret_text";
      readonly state: "PRESENT_PROTECTED_UNCHANGED";
      readonly key_id: string;
      readonly value_observed: false;
    };
    readonly d1_binding: {
      readonly name: typeof PHASE5_WORKER_ACTIVATION_D1_BINDING;
      readonly database_id: typeof PHASE5_WORKER_ACTIVATION_D1_DATABASE_ID;
      readonly state: "UNCHANGED";
    };
    readonly non_target_bindings_sha256: string;
    readonly routes: "UNCHANGED";
    readonly custom_domains: "UNCHANGED";
    readonly triggers: "UNCHANGED";
  };
  readonly allowed_deltas: readonly string[];
  readonly forbidden_deltas: readonly string[];
  readonly one_shot: {
    readonly authorization_consumed_at: "FIRST_WORKER_VERSION_UPLOAD";
    readonly cross_class_cascade: false;
    readonly automatic_retry_rollback_cleanup_or_alternate_mutation: false;
    readonly after_upload_mismatch: "STOP_NO_DEPLOY";
    readonly post_deploy_verification: "GET_ONLY_EXACT_ACTIVE_VERSION_TRAFFIC_BINDINGS_AND_ROUTE_STATE";
  };
}

export interface Phase5WorkerActivationObservedBaseline {
  readonly source_sha: string;
  readonly ci_run_id: string;
  readonly preflight_run_id: string;
  readonly deployment_id: string;
  readonly version_id: string;
  readonly traffic_percent: number;
  readonly ingest_binding_state: Phase5WorkerActivationIngestBindingState;
  readonly verification_key_binding_type: "secret_text";
  readonly verification_key_state: "PRESENT_PROTECTED";
  readonly verification_key_id: string;
  readonly verification_key_provision_run_id: string;
  readonly verification_key_value_observed: false;
  readonly d1_database_id: string;
  readonly d1_migration_state: "PRESENT_VALID_0010_THROUGH_0013";
  readonly non_target_bindings_sha256: string;
}

export class Phase5WorkerActivationCandidateError extends Error {
  constructor() {
    super("Phase 5 Worker activation candidate failed closed");
    this.name = "Phase5WorkerActivationCandidateError";
  }
}

function fail(): never {
  throw new Phase5WorkerActivationCandidateError();
}

function requirePlainRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail();
  return input as Record<string, unknown>;
}

function requireExactFields(
  input: object,
  record: Record<string, unknown>,
  fields: readonly string[],
): void {
  const allowed = new Set(fields);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) fail();
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) fail();
  }
}

function requirePattern(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) fail();
  return value;
}

function requireExactStringArray(value: unknown, expected: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length !== expected.length) fail();
  for (let index = 0; index < expected.length; index += 1) {
    if (value[index] !== expected[index]) fail();
  }
  return [...expected];
}

export function normalizePhase5WorkerActivationCandidateManifest(
  input: unknown,
): Phase5WorkerActivationCandidateManifest {
  const record = requirePlainRecord(input);
  requireExactFields(input as object, record, [
    "schema_version",
    "contract",
    "repository",
    "worker",
    "source_sha",
    "ci_run_id",
    "preflight_run_id",
    "source_config_sha256",
    "toolchain",
    "expected_current",
    "intended_result",
    "allowed_deltas",
    "forbidden_deltas",
    "one_shot",
  ]);

  if (record.schema_version !== PHASE5_WORKER_ACTIVATION_CANDIDATE_SCHEMA_VERSION) fail();
  if (record.contract !== PHASE5_WORKER_ACTIVATION_CANDIDATE_CONTRACT) fail();
  if (record.repository !== PHASE5_WORKER_ACTIVATION_REPOSITORY) fail();
  if (record.worker !== PHASE5_WORKER_ACTIVATION_WORKER) fail();

  const sourceSha = requirePattern(record.source_sha, SHA1_PATTERN);
  const ciRunId = requirePattern(record.ci_run_id, RUN_ID_PATTERN);
  const preflightRunId = requirePattern(record.preflight_run_id, RUN_ID_PATTERN);
  const sourceConfigSha256 = requirePattern(record.source_config_sha256, SHA256_PATTERN);

  const toolchain = requirePlainRecord(record.toolchain);
  requireExactFields(record.toolchain as object, toolchain, ["node_version", "wrangler_version"]);
  if (toolchain.node_version !== PHASE5_WORKER_ACTIVATION_NODE_VERSION) fail();
  if (toolchain.wrangler_version !== PHASE5_WORKER_ACTIVATION_WRANGLER_VERSION) fail();

  const expectedCurrent = requirePlainRecord(record.expected_current);
  requireExactFields(record.expected_current as object, expectedCurrent, [
    "deployment_id",
    "version_id",
    "traffic_percent",
    "ingest_binding_state",
    "verification_key_prerequisite",
    "d1_prerequisite",
    "non_target_bindings_sha256",
  ]);
  const deploymentId = requirePattern(expectedCurrent.deployment_id, UUID_PATTERN);
  const versionId = requirePattern(expectedCurrent.version_id, UUID_PATTERN);
  if (expectedCurrent.traffic_percent !== 100) fail();
  if (
    expectedCurrent.ingest_binding_state !== "ABSENT" &&
    expectedCurrent.ingest_binding_state !== "PRESENT_FALSE"
  ) {
    fail();
  }

  const verificationKey = requirePlainRecord(expectedCurrent.verification_key_prerequisite);
  requireExactFields(expectedCurrent.verification_key_prerequisite as object, verificationKey, [
    "binding",
    "type",
    "state",
    "key_id",
    "provision_run_id",
    "value_observed",
  ]);
  if (verificationKey.binding !== PHASE5_WORKER_ACTIVATION_VERIFICATION_KEY_BINDING) fail();
  if (verificationKey.type !== "secret_text") fail();
  if (verificationKey.state !== "PRESENT_PROTECTED") fail();
  const keyId = requirePattern(verificationKey.key_id, KEY_ID_PATTERN);
  const provisionRunId = requirePattern(verificationKey.provision_run_id, RUN_ID_PATTERN);
  if (verificationKey.value_observed !== false) fail();

  const d1 = requirePlainRecord(expectedCurrent.d1_prerequisite);
  requireExactFields(expectedCurrent.d1_prerequisite as object, d1, [
    "binding",
    "database_id",
    "migration_state",
  ]);
  if (d1.binding !== PHASE5_WORKER_ACTIVATION_D1_BINDING) fail();
  if (d1.database_id !== PHASE5_WORKER_ACTIVATION_D1_DATABASE_ID) fail();
  if (d1.migration_state !== "PRESENT_VALID_0010_THROUGH_0013") fail();
  const nonTargetBindingsSha256 = requirePattern(
    expectedCurrent.non_target_bindings_sha256,
    SHA256_PATTERN,
  );

  const intended = requirePlainRecord(record.intended_result);
  requireExactFields(record.intended_result as object, intended, [
    "version_strategy",
    "ingest_binding",
    "verification_key_binding",
    "d1_binding",
    "non_target_bindings_sha256",
    "routes",
    "custom_domains",
    "triggers",
  ]);
  if (intended.version_strategy !== "UPLOAD_NEW_VERSION_THEN_DEPLOY_EXACT_VERSION_100_PERCENT") fail();

  const ingest = requirePlainRecord(intended.ingest_binding);
  requireExactFields(intended.ingest_binding as object, ingest, ["name", "type", "value"]);
  if (ingest.name !== PHASE5_WORKER_ACTIVATION_INGEST_BINDING) fail();
  if (ingest.type !== "plain_text" || ingest.value !== "true") fail();

  const intendedVerificationKey = requirePlainRecord(intended.verification_key_binding);
  requireExactFields(intended.verification_key_binding as object, intendedVerificationKey, [
    "name",
    "type",
    "state",
    "key_id",
    "value_observed",
  ]);
  if (intendedVerificationKey.name !== PHASE5_WORKER_ACTIVATION_VERIFICATION_KEY_BINDING) fail();
  if (intendedVerificationKey.type !== "secret_text") fail();
  if (intendedVerificationKey.state !== "PRESENT_PROTECTED_UNCHANGED") fail();
  if (intendedVerificationKey.key_id !== keyId) fail();
  if (intendedVerificationKey.value_observed !== false) fail();

  const intendedD1 = requirePlainRecord(intended.d1_binding);
  requireExactFields(intended.d1_binding as object, intendedD1, ["name", "database_id", "state"]);
  if (intendedD1.name !== PHASE5_WORKER_ACTIVATION_D1_BINDING) fail();
  if (intendedD1.database_id !== PHASE5_WORKER_ACTIVATION_D1_DATABASE_ID) fail();
  if (intendedD1.state !== "UNCHANGED") fail();

  const intendedNonTargetBindingsSha256 = requirePattern(
    intended.non_target_bindings_sha256,
    SHA256_PATTERN,
  );
  if (intendedNonTargetBindingsSha256 !== nonTargetBindingsSha256) fail();
  if (intended.routes !== "UNCHANGED") fail();
  if (intended.custom_domains !== "UNCHANGED") fail();
  if (intended.triggers !== "UNCHANGED") fail();

  const allowedDeltas = requireExactStringArray(
    record.allowed_deltas,
    PHASE5_WORKER_ACTIVATION_ALLOWED_DELTAS,
  );
  const forbiddenDeltas = requireExactStringArray(
    record.forbidden_deltas,
    PHASE5_WORKER_ACTIVATION_FORBIDDEN_DELTAS,
  );

  const oneShot = requirePlainRecord(record.one_shot);
  requireExactFields(record.one_shot as object, oneShot, [
    "authorization_consumed_at",
    "cross_class_cascade",
    "automatic_retry_rollback_cleanup_or_alternate_mutation",
    "after_upload_mismatch",
    "post_deploy_verification",
  ]);
  if (oneShot.authorization_consumed_at !== "FIRST_WORKER_VERSION_UPLOAD") fail();
  if (oneShot.cross_class_cascade !== false) fail();
  if (oneShot.automatic_retry_rollback_cleanup_or_alternate_mutation !== false) fail();
  if (oneShot.after_upload_mismatch !== "STOP_NO_DEPLOY") fail();
  if (
    oneShot.post_deploy_verification !==
    "GET_ONLY_EXACT_ACTIVE_VERSION_TRAFFIC_BINDINGS_AND_ROUTE_STATE"
  ) {
    fail();
  }

  return {
    schema_version: PHASE5_WORKER_ACTIVATION_CANDIDATE_SCHEMA_VERSION,
    contract: PHASE5_WORKER_ACTIVATION_CANDIDATE_CONTRACT,
    repository: PHASE5_WORKER_ACTIVATION_REPOSITORY,
    worker: PHASE5_WORKER_ACTIVATION_WORKER,
    source_sha: sourceSha,
    ci_run_id: ciRunId,
    preflight_run_id: preflightRunId,
    source_config_sha256: sourceConfigSha256,
    toolchain: {
      node_version: PHASE5_WORKER_ACTIVATION_NODE_VERSION,
      wrangler_version: PHASE5_WORKER_ACTIVATION_WRANGLER_VERSION,
    },
    expected_current: {
      deployment_id: deploymentId,
      version_id: versionId,
      traffic_percent: 100,
      ingest_binding_state: expectedCurrent.ingest_binding_state,
      verification_key_prerequisite: {
        binding: PHASE5_WORKER_ACTIVATION_VERIFICATION_KEY_BINDING,
        type: "secret_text",
        state: "PRESENT_PROTECTED",
        key_id: keyId,
        provision_run_id: provisionRunId,
        value_observed: false,
      },
      d1_prerequisite: {
        binding: PHASE5_WORKER_ACTIVATION_D1_BINDING,
        database_id: PHASE5_WORKER_ACTIVATION_D1_DATABASE_ID,
        migration_state: "PRESENT_VALID_0010_THROUGH_0013",
      },
      non_target_bindings_sha256: nonTargetBindingsSha256,
    },
    intended_result: {
      version_strategy: "UPLOAD_NEW_VERSION_THEN_DEPLOY_EXACT_VERSION_100_PERCENT",
      ingest_binding: {
        name: PHASE5_WORKER_ACTIVATION_INGEST_BINDING,
        type: "plain_text",
        value: "true",
      },
      verification_key_binding: {
        name: PHASE5_WORKER_ACTIVATION_VERIFICATION_KEY_BINDING,
        type: "secret_text",
        state: "PRESENT_PROTECTED_UNCHANGED",
        key_id: keyId,
        value_observed: false,
      },
      d1_binding: {
        name: PHASE5_WORKER_ACTIVATION_D1_BINDING,
        database_id: PHASE5_WORKER_ACTIVATION_D1_DATABASE_ID,
        state: "UNCHANGED",
      },
      non_target_bindings_sha256: intendedNonTargetBindingsSha256,
      routes: "UNCHANGED",
      custom_domains: "UNCHANGED",
      triggers: "UNCHANGED",
    },
    allowed_deltas: allowedDeltas,
    forbidden_deltas: forbiddenDeltas,
    one_shot: {
      authorization_consumed_at: "FIRST_WORKER_VERSION_UPLOAD",
      cross_class_cascade: false,
      automatic_retry_rollback_cleanup_or_alternate_mutation: false,
      after_upload_mismatch: "STOP_NO_DEPLOY",
      post_deploy_verification: "GET_ONLY_EXACT_ACTIVE_VERSION_TRAFFIC_BINDINGS_AND_ROUTE_STATE",
    },
  };
}

export function assertPhase5WorkerActivationCandidateMatchesObservedBaseline(
  manifest: Phase5WorkerActivationCandidateManifest,
  observed: Phase5WorkerActivationObservedBaseline,
): void {
  if (manifest.source_sha !== observed.source_sha) fail();
  if (manifest.ci_run_id !== observed.ci_run_id) fail();
  if (manifest.preflight_run_id !== observed.preflight_run_id) fail();
  if (manifest.expected_current.deployment_id !== observed.deployment_id) fail();
  if (manifest.expected_current.version_id !== observed.version_id) fail();
  if (observed.traffic_percent !== 100) fail();
  if (manifest.expected_current.ingest_binding_state !== observed.ingest_binding_state) fail();
  if (observed.verification_key_binding_type !== "secret_text") fail();
  if (observed.verification_key_state !== "PRESENT_PROTECTED") fail();
  if (
    manifest.expected_current.verification_key_prerequisite.key_id !==
    observed.verification_key_id
  ) {
    fail();
  }
  if (
    manifest.expected_current.verification_key_prerequisite.provision_run_id !==
    observed.verification_key_provision_run_id
  ) {
    fail();
  }
  if (observed.verification_key_value_observed !== false) fail();
  if (observed.d1_database_id !== PHASE5_WORKER_ACTIVATION_D1_DATABASE_ID) fail();
  if (observed.d1_migration_state !== "PRESENT_VALID_0010_THROUGH_0013") fail();
  if (
    manifest.expected_current.non_target_bindings_sha256 !==
    observed.non_target_bindings_sha256
  ) {
    fail();
  }
}
