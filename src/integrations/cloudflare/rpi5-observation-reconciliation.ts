import {
  assertPhase5Rpi5SignerHandoffMatchesExpectedIdentity,
  normalizePhase5Rpi5SignerHandoffManifest,
  type Phase5Rpi5SignerHandoffManifest,
} from "../../shared/phase5-rpi5-signer-handoff.js";
import {
  MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS,
  normalizeProductionVisibility,
  normalizeSanitizedProductionVisibility,
  type ProductionVisibilityReadModel,
} from "../../shared/production-visibility.js";
import {
  MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS,
  RPI5_OBSERVATION_TRANSPORT_VERSION,
  type Rpi5ObservationUnsignedMetadata,
} from "../../shared/rpi5-observation-transport.js";

export const RPI5_OBSERVATION_RECONCILIATION_CONTRACT_ID =
  "control-phase5-rpi5-observation-reconciliation-v1" as const;

export type Rpi5ObservationReconciliationStatus =
  | "NOT_OBSERVED"
  | "STALE"
  | "DRIFTED"
  | "REJECTED"
  | "ACCEPTED";

export type Rpi5ObservationReconciliationReasonCode =
  | "INVALID_TIME"
  | "INVALID_EXPECTATION"
  | "FUTURE_HANDOFF"
  | "FUTURE_DELIVERY"
  | "FUTURE_VISIBILITY"
  | "DELIVERY_PRECEDES_HANDOFF"
  | "OBSERVATION_AFTER_DELIVERY"
  | "STALE_HANDOFF"
  | "STALE_DELIVERY"
  | "STALE_VISIBILITY"
  | "READ_FAILED"
  | "INVALID_OBSERVATION"
  | "NO_OBSERVATION"
  | "REPLAY_EXPIRY_MISMATCH"
  | "REPLAY_CLAIM_TIME_INVALID"
  | "NON_ATOMIC_REPLAY_CLAIM"
  | "PROJECTION_MISSING"
  | "PROJECTION_NOT_DELIVERY"
  | "PROJECTION_SUPERSEDED"
  | "PROJECT_MISMATCH"
  | "REPOSITORY_MISMATCH"
  | "MAIN_SHA_MISMATCH"
  | "PRODUCTION_SHA_MISMATCH"
  | "DEPLOY_IMPACT_MISMATCH"
  | "RUNTIME_MISMATCH"
  | "HEALTH_MISMATCH"
  | "ROLLBACK_MISMATCH"
  | "BLOCKERS_MISMATCH"
  | "OBSERVED_AT_MISMATCH";

export interface Rpi5ObservationReconciliationWorkerIdentity {
  readonly controlSourceSha: string;
  readonly deploymentId: string;
  readonly versionId: string;
  readonly trafficPercent: 100;
  readonly ingestState: "PRESENT_TRUE";
  readonly keyId: string;
}

export interface Rpi5ObservationReconciliationExpectedState {
  readonly controlSourceSha: string;
  readonly workerDeploymentId: string;
  readonly workerVersionId: string;
  readonly workerTrafficPercent: 100;
  readonly workerIngestState: "PRESENT_TRUE";
  readonly keyId: string;
  readonly handoffGeneratedAt: string;
  readonly delivery: Rpi5ObservationUnsignedMetadata;
  readonly replayKey: string;
  readonly replayExpiresAt: string;
  readonly visibility: ProductionVisibilityReadModel;
}

export interface Rpi5ObservationReconciliationReplayObservation {
  readonly replayKey: string;
  readonly replayExpiresAt: string;
  readonly claimedAt: string;
  readonly atomicAcceptance: boolean;
}

export interface Rpi5ObservationReconciliationProjectionObservation {
  readonly visibility: ProductionVisibilityReadModel;
  readonly storedAt: string;
}

export interface Rpi5ObservationReconciliationObservedState {
  readonly replay: Rpi5ObservationReconciliationReplayObservation;
  readonly projection: Rpi5ObservationReconciliationProjectionObservation | null;
}

export interface Rpi5ObservationReconciliationReceipt {
  readonly contractId: typeof RPI5_OBSERVATION_RECONCILIATION_CONTRACT_ID;
  readonly status: Rpi5ObservationReconciliationStatus;
  readonly reasonCodes: readonly Rpi5ObservationReconciliationReasonCode[];
  readonly expected: Rpi5ObservationReconciliationExpectedState | null;
  readonly observed: Rpi5ObservationReconciliationObservedState | null;
  readonly authority: {
    readonly evidenceOnly: true;
    readonly grantsLiveAuthority: false;
    readonly grantsRpi5Mutation: false;
    readonly grantsCloudflareMutation: false;
    readonly grantsD1Mutation: false;
  };
}

export type Rpi5ObservationReconciliationReadResult =
  | { readonly kind: "NOT_FOUND" }
  | {
      readonly kind: "FOUND";
      readonly replay: Rpi5ObservationReconciliationReplayObservation;
      readonly projection: Rpi5ObservationReconciliationProjectionObservation | null;
    };

export interface Rpi5ObservationReconciliationReader {
  read(
    replayKey: string,
    projectId: string,
    repository: string,
  ): Promise<unknown>;
}

export interface Rpi5ObservationReconciliationD1RunResultLike<Row = Record<string, unknown>> {
  readonly success: boolean;
  readonly results?: readonly Row[];
  readonly meta?: {
    readonly changes?: number;
  };
}

export interface Rpi5ObservationReconciliationD1PreparedStatementLike {
  bind(...values: readonly unknown[]): Rpi5ObservationReconciliationD1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<Rpi5ObservationReconciliationD1RunResultLike<Row>>;
}

export interface Rpi5ObservationReconciliationD1DatabaseLike {
  prepare(query: string): Rpi5ObservationReconciliationD1PreparedStatementLike;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_BLOCKER_CODES_JSON_BYTES = 4096;

const EXPECTATION_FIELDS = ["handoff", "workerIdentity", "delivery", "visibility"] as const;
const WORKER_IDENTITY_FIELDS = [
  "controlSourceSha",
  "deploymentId",
  "versionId",
  "trafficPercent",
  "ingestState",
  "keyId",
] as const;
const DELIVERY_FIELDS = ["version", "deliveryId", "sentAt", "keyId"] as const;
const READ_NOT_FOUND_FIELDS = ["kind"] as const;
const READ_FOUND_FIELDS = ["kind", "replay", "projection"] as const;
const REPLAY_FIELDS = ["replayKey", "replayExpiresAt", "claimedAt", "atomicAcceptance"] as const;
const PROJECTION_FIELDS = ["visibility", "storedAt"] as const;
const STORED_VISIBILITY_FIELDS = [
  "projectId",
  "repository",
  "mainSha",
  "productionSha",
  "deployImpact",
  "runtime",
  "health",
  "rollback",
  "blockerCodes",
  "observedAt",
  "productionAdapter",
  "drift",
] as const;

const D1_ROW_FIELDS = [
  "replay_key",
  "replay_expires_at_ms",
  "claimed_at_ms",
  "atomic_acceptance",
  "project_id",
  "repository",
  "main_sha",
  "production_sha",
  "deploy_impact",
  "runtime",
  "health",
  "rollback",
  "blocker_codes_json",
  "observed_at",
  "observed_at_ms",
  "production_adapter",
  "drift",
  "stored_at",
  "stored_at_ms",
] as const;

const PROJECTION_ROW_FIELDS = [
  "project_id",
  "repository",
  "main_sha",
  "production_sha",
  "deploy_impact",
  "runtime",
  "health",
  "rollback",
  "blocker_codes_json",
  "observed_at",
  "observed_at_ms",
  "production_adapter",
  "drift",
  "stored_at",
  "stored_at_ms",
] as const;

const READ_RECONCILIATION_SQL = `
SELECT
  replay.replay_key,
  replay.replay_expires_at_ms,
  replay.claimed_at_ms,
  CASE
    WHEN length(replay.claim_token) = 32
      AND replay.claim_token NOT GLOB '*[^0-9a-f]*'
    THEN 1
    ELSE 0
  END AS atomic_acceptance,
  projection.project_id,
  projection.repository,
  projection.main_sha,
  projection.production_sha,
  projection.deploy_impact,
  projection.runtime,
  projection.health,
  projection.rollback,
  projection.blocker_codes_json,
  projection.observed_at,
  projection.observed_at_ms,
  projection.production_adapter,
  projection.drift,
  projection.stored_at,
  projection.stored_at_ms
FROM rpi5_observation_replay_claims AS replay
LEFT JOIN rpi5_production_visibility AS projection
  ON projection.project_id = ?2
  AND projection.repository = ?3
WHERE replay.replay_key = ?1
LIMIT 2
`.trim();

function failExpectation(): never {
  throw new Error("invalid RPi5 observation reconciliation expectation");
}

function requirePlainRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) failExpectation();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) failExpectation();
  return input as Record<string, unknown>;
}

function requireExactFields(
  input: object,
  record: Record<string, unknown>,
  fields: readonly string[],
): void {
  const allowed = new Set(fields);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) failExpectation();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) failExpectation();
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) failExpectation();
  }
}

function requirePattern(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) failExpectation();
  return value;
}

function requireCanonicalTimestamp(value: unknown): {
  readonly value: string;
  readonly milliseconds: number;
} {
  if (typeof value !== "string") failExpectation();
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    new Date(milliseconds).toISOString() !== value
  ) {
    failExpectation();
  }
  return { value, milliseconds };
}

function timestampFromMilliseconds(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) failExpectation();
  return new Date(value as number).toISOString();
}

function normalizeWorkerIdentity(input: unknown): Rpi5ObservationReconciliationWorkerIdentity {
  const record = requirePlainRecord(input);
  requireExactFields(input as object, record, WORKER_IDENTITY_FIELDS);
  const controlSourceSha = requirePattern(record.controlSourceSha, SHA_PATTERN);
  const deploymentId = requirePattern(record.deploymentId, UUID_PATTERN);
  const versionId = requirePattern(record.versionId, UUID_PATTERN);
  const keyId = requirePattern(record.keyId, KEY_ID_PATTERN);
  if (record.trafficPercent !== 100 || record.ingestState !== "PRESENT_TRUE") failExpectation();
  return {
    controlSourceSha,
    deploymentId,
    versionId,
    trafficPercent: 100,
    ingestState: "PRESENT_TRUE",
    keyId,
  };
}

function normalizeHandoffWithoutCurrentFreshness(input: unknown): Phase5Rpi5SignerHandoffManifest {
  const record = requirePlainRecord(input);
  const generatedAt = requireCanonicalTimestamp(record.generated_at).value;
  return normalizePhase5Rpi5SignerHandoffManifest(input, generatedAt);
}

function normalizeDelivery(input: unknown): Rpi5ObservationUnsignedMetadata {
  const record = requirePlainRecord(input);
  requireExactFields(input as object, record, DELIVERY_FIELDS);
  if (record.version !== RPI5_OBSERVATION_TRANSPORT_VERSION) failExpectation();
  return {
    version: RPI5_OBSERVATION_TRANSPORT_VERSION,
    deliveryId: requirePattern(record.deliveryId, DELIVERY_ID_PATTERN),
    sentAt: requireCanonicalTimestamp(record.sentAt).value,
    keyId: requirePattern(record.keyId, KEY_ID_PATTERN),
  };
}

function normalizeExpectedVisibility(input: unknown): ProductionVisibilityReadModel {
  const record = requirePlainRecord(input);
  const observedAt = requireCanonicalTimestamp(record.observedAt).value;
  return normalizeSanitizedProductionVisibility(input, observedAt);
}

function normalizeStoredVisibility(input: unknown): ProductionVisibilityReadModel {
  const record = requirePlainRecord(input);
  requireExactFields(input as object, record, STORED_VISIBILITY_FIELDS);
  const observedAt = requireCanonicalTimestamp(record.observedAt).value;
  const normalized = normalizeProductionVisibility(
    {
      projectId: record.projectId as string,
      repository: record.repository as string,
      mainSha: record.mainSha as string,
      productionSha: record.productionSha as string,
      deployImpact: record.deployImpact as ProductionVisibilityReadModel["deployImpact"],
      runtime: record.runtime as ProductionVisibilityReadModel["runtime"],
      health: record.health as ProductionVisibilityReadModel["health"],
      rollback: record.rollback as ProductionVisibilityReadModel["rollback"],
      blockerCodes: record.blockerCodes as readonly string[],
      observedAt,
    },
    observedAt,
  );
  if (
    record.productionAdapter !== normalized.productionAdapter ||
    record.drift !== normalized.drift
  ) {
    failExpectation();
  }
  return normalized;
}

function toExpectedState(
  handoff: Phase5Rpi5SignerHandoffManifest,
  worker: Rpi5ObservationReconciliationWorkerIdentity,
  delivery: Rpi5ObservationUnsignedMetadata,
  visibility: ProductionVisibilityReadModel,
): Rpi5ObservationReconciliationExpectedState {
  const replayExpiresAt = new Date(
    Date.parse(delivery.sentAt) + MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS,
  ).toISOString();
  return {
    controlSourceSha: worker.controlSourceSha,
    workerDeploymentId: worker.deploymentId,
    workerVersionId: worker.versionId,
    workerTrafficPercent: 100,
    workerIngestState: "PRESENT_TRUE",
    keyId: worker.keyId,
    handoffGeneratedAt: handoff.generated_at,
    delivery,
    replayKey: `${delivery.keyId}:${delivery.deliveryId}`,
    replayExpiresAt,
    visibility,
  };
}

function receipt(
  status: Rpi5ObservationReconciliationStatus,
  reasonCodes: readonly Rpi5ObservationReconciliationReasonCode[],
  expected: Rpi5ObservationReconciliationExpectedState | null,
  observed: Rpi5ObservationReconciliationObservedState | null,
): Rpi5ObservationReconciliationReceipt {
  return {
    contractId: RPI5_OBSERVATION_RECONCILIATION_CONTRACT_ID,
    status,
    reasonCodes,
    expected,
    observed,
    authority: {
      evidenceOnly: true,
      grantsLiveAuthority: false,
      grantsRpi5Mutation: false,
      grantsCloudflareMutation: false,
      grantsD1Mutation: false,
    },
  };
}

function blockerCodesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function visibilityMismatchReasons(
  expected: ProductionVisibilityReadModel,
  observed: ProductionVisibilityReadModel,
): readonly Rpi5ObservationReconciliationReasonCode[] {
  const reasons: Rpi5ObservationReconciliationReasonCode[] = [];
  if (expected.projectId !== observed.projectId) reasons.push("PROJECT_MISMATCH");
  if (expected.repository !== observed.repository) reasons.push("REPOSITORY_MISMATCH");
  if (expected.mainSha !== observed.mainSha) reasons.push("MAIN_SHA_MISMATCH");
  if (expected.productionSha !== observed.productionSha) reasons.push("PRODUCTION_SHA_MISMATCH");
  if (expected.deployImpact !== observed.deployImpact) reasons.push("DEPLOY_IMPACT_MISMATCH");
  if (expected.runtime !== observed.runtime) reasons.push("RUNTIME_MISMATCH");
  if (expected.health !== observed.health) reasons.push("HEALTH_MISMATCH");
  if (expected.rollback !== observed.rollback) reasons.push("ROLLBACK_MISMATCH");
  if (!blockerCodesEqual(expected.blockerCodes, observed.blockerCodes)) {
    reasons.push("BLOCKERS_MISMATCH");
  }
  if (expected.observedAt !== observed.observedAt) reasons.push("OBSERVED_AT_MISMATCH");
  return reasons;
}

function normalizeExpected(
  input: unknown,
  now: { readonly value: string; readonly milliseconds: number },
): {
  readonly expected: Rpi5ObservationReconciliationExpectedState;
  readonly terminal: Rpi5ObservationReconciliationReceipt | null;
} {
  const record = requirePlainRecord(input);
  requireExactFields(input as object, record, EXPECTATION_FIELDS);

  const worker = normalizeWorkerIdentity(record.workerIdentity);
  const handoff = normalizeHandoffWithoutCurrentFreshness(record.handoff);
  assertPhase5Rpi5SignerHandoffMatchesExpectedIdentity(handoff, {
    control_source_sha: worker.controlSourceSha,
    deployment_id: worker.deploymentId,
    version_id: worker.versionId,
    key_id: worker.keyId,
  });
  const delivery = normalizeDelivery(record.delivery);
  if (delivery.keyId !== worker.keyId) failExpectation();
  const visibility = normalizeExpectedVisibility(record.visibility);
  const expected = toExpectedState(handoff, worker, delivery, visibility);

  const handoffAt = Date.parse(expected.handoffGeneratedAt);
  const sentAt = Date.parse(expected.delivery.sentAt);
  const observedAt = Date.parse(expected.visibility.observedAt);

  const futureReasons: Rpi5ObservationReconciliationReasonCode[] = [];
  if (handoffAt > now.milliseconds) futureReasons.push("FUTURE_HANDOFF");
  if (sentAt > now.milliseconds) futureReasons.push("FUTURE_DELIVERY");
  if (observedAt > now.milliseconds) futureReasons.push("FUTURE_VISIBILITY");
  if (futureReasons.length > 0) {
    return { expected, terminal: receipt("REJECTED", futureReasons, expected, null) };
  }

  const chronologyReasons: Rpi5ObservationReconciliationReasonCode[] = [];
  if (sentAt < handoffAt) chronologyReasons.push("DELIVERY_PRECEDES_HANDOFF");
  if (observedAt > sentAt) chronologyReasons.push("OBSERVATION_AFTER_DELIVERY");
  if (chronologyReasons.length > 0) {
    return { expected, terminal: receipt("REJECTED", chronologyReasons, expected, null) };
  }

  const staleReasons: Rpi5ObservationReconciliationReasonCode[] = [];
  if (now.milliseconds - handoffAt > MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS) {
    staleReasons.push("STALE_HANDOFF");
  }
  if (now.milliseconds - sentAt > MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS) {
    staleReasons.push("STALE_DELIVERY");
  }
  if (now.milliseconds - observedAt > MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS) {
    staleReasons.push("STALE_VISIBILITY");
  }
  if (staleReasons.length > 0) {
    return { expected, terminal: receipt("STALE", staleReasons, expected, null) };
  }

  return { expected, terminal: null };
}

function normalizeReadResult(
  input: unknown,
  expected: Rpi5ObservationReconciliationExpectedState,
): Rpi5ObservationReconciliationReadResult {
  const record = requirePlainRecord(input);
  const kind = record.kind;
  if (kind === "NOT_FOUND") {
    requireExactFields(input as object, record, READ_NOT_FOUND_FIELDS);
    return { kind };
  }
  if (kind !== "FOUND") failExpectation();
  requireExactFields(input as object, record, READ_FOUND_FIELDS);

  const replayRecord = requirePlainRecord(record.replay);
  requireExactFields(record.replay as object, replayRecord, REPLAY_FIELDS);
  let atomicAcceptance: boolean;
  if (replayRecord.atomicAcceptance === true) {
    atomicAcceptance = true;
  } else if (replayRecord.atomicAcceptance === false) {
    atomicAcceptance = false;
  } else {
    failExpectation();
  }
  const replay: Rpi5ObservationReconciliationReplayObservation = {
    replayKey: requirePattern(replayRecord.replayKey, /^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/),
    replayExpiresAt: requireCanonicalTimestamp(replayRecord.replayExpiresAt).value,
    claimedAt: requireCanonicalTimestamp(replayRecord.claimedAt).value,
    atomicAcceptance,
  };
  if (replay.replayKey !== expected.replayKey) failExpectation();

  let projection: Rpi5ObservationReconciliationProjectionObservation | null = null;
  if (record.projection !== null) {
    const projectionRecord = requirePlainRecord(record.projection);
    requireExactFields(record.projection as object, projectionRecord, PROJECTION_FIELDS);
    projection = {
      visibility: normalizeStoredVisibility(projectionRecord.visibility),
      storedAt: requireCanonicalTimestamp(projectionRecord.storedAt).value,
    };
    if (Date.parse(projection.storedAt) < Date.parse(projection.visibility.observedAt)) failExpectation();
  }

  return { kind, replay, projection };
}

function normalizeD1Row(
  input: unknown,
  expectedReplayKey: string,
  expectedProjectId: string,
  expectedRepository: string,
): Rpi5ObservationReconciliationReadResult {
  const row = requirePlainRecord(input);
  requireExactFields(input as object, row, D1_ROW_FIELDS);
  if (row.replay_key !== expectedReplayKey) failExpectation();

  const replayExpiresAt = timestampFromMilliseconds(row.replay_expires_at_ms);
  const claimedAt = timestampFromMilliseconds(row.claimed_at_ms);
  if (row.atomic_acceptance !== 0 && row.atomic_acceptance !== 1) failExpectation();

  const projectionNullCount = PROJECTION_ROW_FIELDS.filter((field) => row[field] === null).length;
  let projection: Rpi5ObservationReconciliationProjectionObservation | null = null;
  if (projectionNullCount === PROJECTION_ROW_FIELDS.length) {
    projection = null;
  } else {
    if (projectionNullCount !== 0) failExpectation();
    if (row.project_id !== expectedProjectId || row.repository !== expectedRepository) failExpectation();
    if (typeof row.blocker_codes_json !== "string") failExpectation();
    if (new TextEncoder().encode(row.blocker_codes_json).byteLength > MAX_BLOCKER_CODES_JSON_BYTES) {
      failExpectation();
    }
    let blockerCodes: unknown;
    try {
      blockerCodes = JSON.parse(row.blocker_codes_json);
    } catch {
      failExpectation();
    }
    const observedAt = requireCanonicalTimestamp(row.observed_at);
    if (row.observed_at_ms !== observedAt.milliseconds) failExpectation();
    const storedAt = requireCanonicalTimestamp(row.stored_at);
    if (row.stored_at_ms !== storedAt.milliseconds || storedAt.milliseconds < observedAt.milliseconds) {
      failExpectation();
    }
    const visibility = normalizeStoredVisibility({
      projectId: row.project_id,
      repository: row.repository,
      mainSha: row.main_sha,
      productionSha: row.production_sha,
      deployImpact: row.deploy_impact,
      runtime: row.runtime,
      health: row.health,
      rollback: row.rollback,
      blockerCodes,
      observedAt: observedAt.value,
      productionAdapter: row.production_adapter,
      drift: row.drift,
    });
    projection = { visibility, storedAt: storedAt.value };
  }

  return {
    kind: "FOUND",
    replay: {
      replayKey: expectedReplayKey,
      replayExpiresAt,
      claimedAt,
      atomicAcceptance: row.atomic_acceptance === 1,
    },
    projection,
  };
}

export class D1Rpi5ObservationReconciliationReader implements Rpi5ObservationReconciliationReader {
  constructor(private readonly database: Rpi5ObservationReconciliationD1DatabaseLike) {}

  async read(
    replayKey: string,
    projectId: string,
    repository: string,
  ): Promise<Rpi5ObservationReconciliationReadResult> {
    let result: Rpi5ObservationReconciliationD1RunResultLike;
    try {
      result = await this.database
        .prepare(READ_RECONCILIATION_SQL)
        .bind(replayKey, projectId, repository)
        .run();
    } catch {
      throw new Error("RPi5 reconciliation D1 read failed closed");
    }

    if (
      result.success !== true ||
      !Array.isArray(result.results) ||
      (result.meta?.changes !== undefined && result.meta.changes !== 0) ||
      result.results.length > 1
    ) {
      throw new Error("RPi5 reconciliation D1 read failed closed");
    }
    if (result.results.length === 0) return { kind: "NOT_FOUND" };
    return normalizeD1Row(result.results[0], replayKey, projectId, repository);
  }
}

/**
 * Read-only reconciliation of one expected signed observation against the durable
 * atomic replay claim and current monotonic production-visibility projection.
 *
 * This function does not read a signature, raw payload, key value or claim-token value,
 * and it grants no Worker, D1, Cloudflare or RPi5 mutation authority. `ACCEPTED` means
 * the exact public-safe expectation matches the durable atomic-acceptance marker and
 * the projection written at that same acceptance time under the merged source contract.
 */
export async function reconcileRpi5Observation(
  reader: Rpi5ObservationReconciliationReader,
  expectationInput: unknown,
  nowInput: unknown,
): Promise<Rpi5ObservationReconciliationReceipt> {
  let now: { readonly value: string; readonly milliseconds: number };
  try {
    now = requireCanonicalTimestamp(nowInput);
  } catch {
    return receipt("REJECTED", ["INVALID_TIME"], null, null);
  }

  let normalizedExpected: {
    readonly expected: Rpi5ObservationReconciliationExpectedState;
    readonly terminal: Rpi5ObservationReconciliationReceipt | null;
  };
  try {
    normalizedExpected = normalizeExpected(expectationInput, now);
  } catch {
    return receipt("REJECTED", ["INVALID_EXPECTATION"], null, null);
  }
  if (normalizedExpected.terminal) return normalizedExpected.terminal;
  const expected = normalizedExpected.expected;

  let rawRead: unknown;
  try {
    rawRead = await reader.read(
      expected.replayKey,
      expected.visibility.projectId,
      expected.visibility.repository,
    );
  } catch {
    return receipt("REJECTED", ["READ_FAILED"], expected, null);
  }

  let read: Rpi5ObservationReconciliationReadResult;
  try {
    read = normalizeReadResult(rawRead, expected);
  } catch {
    return receipt("REJECTED", ["INVALID_OBSERVATION"], expected, null);
  }
  if (read.kind === "NOT_FOUND") {
    return receipt("NOT_OBSERVED", ["NO_OBSERVATION"], expected, null);
  }

  const observed: Rpi5ObservationReconciliationObservedState = {
    replay: read.replay,
    projection: read.projection,
  };

  if (read.replay.replayExpiresAt !== expected.replayExpiresAt) {
    return receipt("REJECTED", ["REPLAY_EXPIRY_MISMATCH"], expected, observed);
  }
  const claimedAt = Date.parse(read.replay.claimedAt);
  const sentAt = Date.parse(expected.delivery.sentAt);
  const replayExpiresAt = Date.parse(expected.replayExpiresAt);
  if (claimedAt < sentAt || claimedAt >= replayExpiresAt || claimedAt > now.milliseconds) {
    return receipt("REJECTED", ["REPLAY_CLAIM_TIME_INVALID"], expected, observed);
  }
  if (!read.replay.atomicAcceptance) {
    return receipt("REJECTED", ["NON_ATOMIC_REPLAY_CLAIM"], expected, observed);
  }
  if (!read.projection) {
    return receipt("REJECTED", ["PROJECTION_MISSING"], expected, observed);
  }

  const reasons: Rpi5ObservationReconciliationReasonCode[] = [];
  const projectionStoredAt = Date.parse(read.projection.storedAt);
  if (projectionStoredAt < claimedAt) reasons.push("PROJECTION_NOT_DELIVERY");
  if (projectionStoredAt > claimedAt) reasons.push("PROJECTION_SUPERSEDED");
  reasons.push(...visibilityMismatchReasons(expected.visibility, read.projection.visibility));
  if (reasons.length > 0) return receipt("DRIFTED", reasons, expected, observed);

  return receipt("ACCEPTED", [], expected, observed);
}
