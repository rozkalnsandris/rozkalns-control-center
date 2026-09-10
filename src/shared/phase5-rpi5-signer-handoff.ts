import {
  MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS,
  RPI5_OBSERVATION_TRANSPORT_VERSION,
} from "./rpi5-observation-transport.js";

export const PHASE5_RPI5_SIGNER_HANDOFF_SCHEMA_VERSION = 1 as const;
export const PHASE5_RPI5_SIGNER_HANDOFF_CONTRACT = "PHASE5_RPI5_SIGNER_HANDOFF_V1" as const;
export const PHASE5_RPI5_SIGNER_HANDOFF_SOURCE_REPOSITORY =
  "rozkalnsandris/rozkalns-control-center" as const;
export const PHASE5_RPI5_SIGNER_HANDOFF_WORKER = "rozkalns-control" as const;
export const PHASE5_RPI5_SIGNER_HANDOFF_RECEIVER_REPOSITORY =
  "rozkalnsandris/RPi5_main" as const;
export const PHASE5_RPI5_SIGNER_HANDOFF_RECEIVER_LANE = "RPI5_SIGNER_RUNTIME" as const;
export const PHASE5_RPI5_SIGNER_HANDOFF_AUTHORITY_OWNER = "RPi5_main" as const;
export const PHASE5_RPI5_SIGNER_HANDOFF_MAX_AGE_MS = MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS;

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface Phase5Rpi5SignerHandoffManifest {
  readonly schema_version: typeof PHASE5_RPI5_SIGNER_HANDOFF_SCHEMA_VERSION;
  readonly contract: typeof PHASE5_RPI5_SIGNER_HANDOFF_CONTRACT;
  readonly source_repository: typeof PHASE5_RPI5_SIGNER_HANDOFF_SOURCE_REPOSITORY;
  readonly control_source_sha: string;
  readonly worker: typeof PHASE5_RPI5_SIGNER_HANDOFF_WORKER;
  readonly expected_worker: {
    readonly deployment_id: string;
    readonly version_id: string;
    readonly traffic_percent: 100;
    readonly ingest_state: "PRESENT_TRUE";
  };
  readonly key_id: string;
  readonly observation_contract_version: typeof RPI5_OBSERVATION_TRANSPORT_VERSION;
  readonly generated_at: string;
  readonly receiver: {
    readonly repository: typeof PHASE5_RPI5_SIGNER_HANDOFF_RECEIVER_REPOSITORY;
    readonly lane: typeof PHASE5_RPI5_SIGNER_HANDOFF_RECEIVER_LANE;
    readonly authority_owner: typeof PHASE5_RPI5_SIGNER_HANDOFF_AUTHORITY_OWNER;
  };
  readonly authority: {
    readonly evidence_only: true;
    readonly grants_live_authority: false;
    readonly grants_cross_repo_write: false;
    readonly grants_rpi5_runtime_mutation: false;
  };
}

export interface Phase5Rpi5SignerHandoffExpectedIdentity {
  readonly control_source_sha: string;
  readonly deployment_id: string;
  readonly version_id: string;
  readonly key_id: string;
}

export class Phase5Rpi5SignerHandoffError extends Error {
  constructor() {
    super("Phase 5 RPi5 signer handoff failed closed");
    this.name = "Phase5Rpi5SignerHandoffError";
  }
}

function fail(): never {
  throw new Phase5Rpi5SignerHandoffError();
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

function requireCanonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") fail();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) fail();
  return value;
}

export function normalizePhase5Rpi5SignerHandoffManifest(
  input: unknown,
  nowInput: string,
): Phase5Rpi5SignerHandoffManifest {
  const record = requirePlainRecord(input);
  requireExactFields(input as object, record, [
    "schema_version",
    "contract",
    "source_repository",
    "control_source_sha",
    "worker",
    "expected_worker",
    "key_id",
    "observation_contract_version",
    "generated_at",
    "receiver",
    "authority",
  ]);

  if (record.schema_version !== PHASE5_RPI5_SIGNER_HANDOFF_SCHEMA_VERSION) fail();
  if (record.contract !== PHASE5_RPI5_SIGNER_HANDOFF_CONTRACT) fail();
  if (record.source_repository !== PHASE5_RPI5_SIGNER_HANDOFF_SOURCE_REPOSITORY) fail();
  const controlSourceSha = requirePattern(record.control_source_sha, SHA1_PATTERN);
  if (record.worker !== PHASE5_RPI5_SIGNER_HANDOFF_WORKER) fail();

  const expectedWorker = requirePlainRecord(record.expected_worker);
  requireExactFields(record.expected_worker as object, expectedWorker, [
    "deployment_id",
    "version_id",
    "traffic_percent",
    "ingest_state",
  ]);
  const deploymentId = requirePattern(expectedWorker.deployment_id, UUID_PATTERN);
  const versionId = requirePattern(expectedWorker.version_id, UUID_PATTERN);
  if (expectedWorker.traffic_percent !== 100) fail();
  if (expectedWorker.ingest_state !== "PRESENT_TRUE") fail();

  const keyId = requirePattern(record.key_id, KEY_ID_PATTERN);
  if (record.observation_contract_version !== RPI5_OBSERVATION_TRANSPORT_VERSION) fail();

  const generatedAt = requireCanonicalTimestamp(record.generated_at);
  const now = requireCanonicalTimestamp(nowInput);
  const ageMs = Date.parse(now) - Date.parse(generatedAt);
  if (ageMs < 0 || ageMs > PHASE5_RPI5_SIGNER_HANDOFF_MAX_AGE_MS) fail();

  const receiver = requirePlainRecord(record.receiver);
  requireExactFields(record.receiver as object, receiver, [
    "repository",
    "lane",
    "authority_owner",
  ]);
  if (receiver.repository !== PHASE5_RPI5_SIGNER_HANDOFF_RECEIVER_REPOSITORY) fail();
  if (receiver.lane !== PHASE5_RPI5_SIGNER_HANDOFF_RECEIVER_LANE) fail();
  if (receiver.authority_owner !== PHASE5_RPI5_SIGNER_HANDOFF_AUTHORITY_OWNER) fail();

  const authority = requirePlainRecord(record.authority);
  requireExactFields(record.authority as object, authority, [
    "evidence_only",
    "grants_live_authority",
    "grants_cross_repo_write",
    "grants_rpi5_runtime_mutation",
  ]);
  if (authority.evidence_only !== true) fail();
  if (authority.grants_live_authority !== false) fail();
  if (authority.grants_cross_repo_write !== false) fail();
  if (authority.grants_rpi5_runtime_mutation !== false) fail();

  return {
    schema_version: PHASE5_RPI5_SIGNER_HANDOFF_SCHEMA_VERSION,
    contract: PHASE5_RPI5_SIGNER_HANDOFF_CONTRACT,
    source_repository: PHASE5_RPI5_SIGNER_HANDOFF_SOURCE_REPOSITORY,
    control_source_sha: controlSourceSha,
    worker: PHASE5_RPI5_SIGNER_HANDOFF_WORKER,
    expected_worker: {
      deployment_id: deploymentId,
      version_id: versionId,
      traffic_percent: 100,
      ingest_state: "PRESENT_TRUE",
    },
    key_id: keyId,
    observation_contract_version: RPI5_OBSERVATION_TRANSPORT_VERSION,
    generated_at: generatedAt,
    receiver: {
      repository: PHASE5_RPI5_SIGNER_HANDOFF_RECEIVER_REPOSITORY,
      lane: PHASE5_RPI5_SIGNER_HANDOFF_RECEIVER_LANE,
      authority_owner: PHASE5_RPI5_SIGNER_HANDOFF_AUTHORITY_OWNER,
    },
    authority: {
      evidence_only: true,
      grants_live_authority: false,
      grants_cross_repo_write: false,
      grants_rpi5_runtime_mutation: false,
    },
  };
}

export function assertPhase5Rpi5SignerHandoffMatchesExpectedIdentity(
  manifest: Phase5Rpi5SignerHandoffManifest,
  expected: Phase5Rpi5SignerHandoffExpectedIdentity,
): void {
  const expectedSourceSha = requirePattern(expected.control_source_sha, SHA1_PATTERN);
  const expectedDeploymentId = requirePattern(expected.deployment_id, UUID_PATTERN);
  const expectedVersionId = requirePattern(expected.version_id, UUID_PATTERN);
  const expectedKeyId = requirePattern(expected.key_id, KEY_ID_PATTERN);

  if (manifest.control_source_sha !== expectedSourceSha) fail();
  if (manifest.expected_worker.deployment_id !== expectedDeploymentId) fail();
  if (manifest.expected_worker.version_id !== expectedVersionId) fail();
  if (manifest.key_id !== expectedKeyId) fail();
}
