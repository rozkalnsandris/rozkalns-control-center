import {
  normalizeProductionVisibility,
  type ProductionVisibilityEvidence,
  type ProductionVisibilityReadModel,
} from "../../shared/production-visibility.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import type {
  D1DatabaseLike,
  D1RunResultLike,
} from "./d1-delivery-claim-store.js";

const VISIBILITY_FIELDS = [
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

const VISIBILITY_FIELD_SET = new Set<string>(VISIBILITY_FIELDS);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAX_BLOCKER_CODES_JSON_BYTES = 4096;

const UPSERT_VISIBILITY_SQL = `
INSERT INTO rpi5_production_visibility (
  project_id,
  repository,
  main_sha,
  production_sha,
  deploy_impact,
  runtime,
  health,
  rollback,
  blocker_codes_json,
  observed_at,
  observed_at_ms,
  production_adapter,
  drift,
  stored_at,
  stored_at_ms
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
)
ON CONFLICT(project_id) DO UPDATE SET
  repository = excluded.repository,
  main_sha = excluded.main_sha,
  production_sha = excluded.production_sha,
  deploy_impact = excluded.deploy_impact,
  runtime = excluded.runtime,
  health = excluded.health,
  rollback = excluded.rollback,
  blocker_codes_json = excluded.blocker_codes_json,
  observed_at = excluded.observed_at,
  observed_at_ms = excluded.observed_at_ms,
  production_adapter = excluded.production_adapter,
  drift = excluded.drift,
  stored_at = excluded.stored_at,
  stored_at_ms = excluded.stored_at_ms
WHERE rpi5_production_visibility.observed_at_ms < excluded.observed_at_ms
`.trim();

const READ_VISIBILITY_SQL = `
SELECT
  project_id,
  repository,
  main_sha,
  production_sha,
  deploy_impact,
  runtime,
  health,
  rollback,
  blocker_codes_json,
  observed_at,
  observed_at_ms,
  production_adapter,
  drift,
  stored_at,
  stored_at_ms
FROM rpi5_production_visibility
WHERE project_id = ?1 AND repository = ?2
LIMIT 2
`.trim();

export type Rpi5ProductionVisibilityWriteResult = "STORED" | "NOT_NEWER";

export type Rpi5ProductionVisibilityReadResult =
  | { readonly kind: "NOT_FOUND" }
  | {
      readonly kind: "FOUND";
      readonly visibility: ProductionVisibilityReadModel;
      readonly storedAt: string;
    };

export type Rpi5ProductionVisibilityStoreErrorCode =
  | "INVALID_INPUT"
  | "D1_FAILURE"
  | "INVALID_STORED_ROW";

export class Rpi5ProductionVisibilityStoreError extends Error {
  readonly code: Rpi5ProductionVisibilityStoreErrorCode;

  constructor(code: Rpi5ProductionVisibilityStoreErrorCode) {
    super("RPi5 production visibility store failed closed");
    this.name = "Rpi5ProductionVisibilityStoreError";
    this.code = code;
  }
}

interface StoredVisibilityRow {
  readonly project_id: unknown;
  readonly repository: unknown;
  readonly main_sha: unknown;
  readonly production_sha: unknown;
  readonly deploy_impact: unknown;
  readonly runtime: unknown;
  readonly health: unknown;
  readonly rollback: unknown;
  readonly blocker_codes_json: unknown;
  readonly observed_at: unknown;
  readonly observed_at_ms: unknown;
  readonly production_adapter: unknown;
  readonly drift: unknown;
  readonly stored_at: unknown;
  readonly stored_at_ms: unknown;
}

function fail(code: Rpi5ProductionVisibilityStoreErrorCode): never {
  throw new Rpi5ProductionVisibilityStoreError(code);
}

function requireCanonicalTimestamp(
  value: unknown,
  code: Rpi5ProductionVisibilityStoreErrorCode,
): { readonly value: string; readonly milliseconds: number } {
  if (typeof value !== "string") fail(code);
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(code);
  }
  return { value, milliseconds };
}

function requireExactPlainObject(
  input: unknown,
  fields: readonly string[],
  fieldSet: ReadonlySet<string>,
  code: Rpi5ProductionVisibilityStoreErrorCode,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(code);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail(code);

  const record = input as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !fieldSet.has(key)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(code);
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) fail(code);
  }
  return record;
}

function normalizeVisibilityInput(
  input: unknown,
  code: Rpi5ProductionVisibilityStoreErrorCode,
): ProductionVisibilityReadModel {
  const record = requireExactPlainObject(input, VISIBILITY_FIELDS, VISIBILITY_FIELD_SET, code);

  const evidence: ProductionVisibilityEvidence = {
    projectId: record.projectId as string,
    repository: record.repository as string,
    mainSha: record.mainSha as string,
    productionSha: record.productionSha as string,
    deployImpact: record.deployImpact as ProductionVisibilityEvidence["deployImpact"],
    runtime: record.runtime as ProductionVisibilityEvidence["runtime"],
    health: record.health as ProductionVisibilityEvidence["health"],
    rollback: record.rollback as ProductionVisibilityEvidence["rollback"],
    blockerCodes: record.blockerCodes as readonly string[],
    observedAt: record.observedAt as string,
  };

  let normalized: ProductionVisibilityReadModel;
  try {
    normalized = normalizeProductionVisibility(evidence, evidence.observedAt);
  } catch {
    fail(code);
  }

  if (
    record.productionAdapter !== normalized.productionAdapter ||
    record.drift !== normalized.drift
  ) {
    fail(code);
  }
  return normalized;
}

function requireReadIdentity(
  projectIdInput: unknown,
  repositoryInput: unknown,
): { readonly projectId: string; readonly repository: string } {
  if (
    typeof projectIdInput !== "string" ||
    !PROJECT_ID_PATTERN.test(projectIdInput) ||
    typeof repositoryInput !== "string"
  ) {
    fail("INVALID_INPUT");
  }

  let policy;
  try {
    policy = requireManagedProjectPolicy(repositoryInput);
  } catch {
    fail("INVALID_INPUT");
  }
  if (
    policy.id !== projectIdInput ||
    policy.repository !== repositoryInput ||
    policy.productionAdapter !== "rpi5"
  ) {
    fail("INVALID_INPUT");
  }
  return { projectId: policy.id, repository: policy.repository };
}

function requireBlockerCodesJson(
  value: unknown,
  code: Rpi5ProductionVisibilityStoreErrorCode,
): readonly string[] {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    new TextEncoder().encode(value).byteLength > MAX_BLOCKER_CODES_JSON_BYTES
  ) {
    fail(code);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail(code);
  }
  if (!Array.isArray(parsed)) fail(code);
  return parsed as readonly string[];
}

async function runWrite(
  database: D1DatabaseLike,
  values: readonly unknown[],
): Promise<D1RunResultLike> {
  try {
    return await database.prepare(UPSERT_VISIBILITY_SQL).bind(...values).run();
  } catch {
    fail("D1_FAILURE");
  }
}

async function runRead(
  database: D1DatabaseLike,
  projectId: string,
  repository: string,
): Promise<D1RunResultLike<StoredVisibilityRow>> {
  try {
    return await database
      .prepare(READ_VISIBILITY_SQL)
      .bind(projectId, repository)
      .run<StoredVisibilityRow>();
  } catch {
    fail("D1_FAILURE");
  }
}

function requireSuccessfulRows<Row>(
  result: D1RunResultLike<Row>,
): readonly Row[] {
  if (!result || result.success !== true || !Array.isArray(result.results)) {
    fail("D1_FAILURE");
  }
  return result.results;
}

function normalizeStoredRow(
  rowInput: unknown,
  expectedProjectId: string,
  expectedRepository: string,
): { readonly visibility: ProductionVisibilityReadModel; readonly storedAt: string } {
  const fields = [
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
  const record = requireExactPlainObject(
    rowInput,
    fields,
    new Set<string>(fields),
    "INVALID_STORED_ROW",
  );

  if (record.project_id !== expectedProjectId || record.repository !== expectedRepository) {
    fail("INVALID_STORED_ROW");
  }

  const observedAt = requireCanonicalTimestamp(record.observed_at, "INVALID_STORED_ROW");
  const storedAt = requireCanonicalTimestamp(record.stored_at, "INVALID_STORED_ROW");
  if (
    record.observed_at_ms !== observedAt.milliseconds ||
    record.stored_at_ms !== storedAt.milliseconds ||
    storedAt.milliseconds < observedAt.milliseconds
  ) {
    fail("INVALID_STORED_ROW");
  }

  const blockerCodes = requireBlockerCodesJson(
    record.blocker_codes_json,
    "INVALID_STORED_ROW",
  );
  const visibility = normalizeVisibilityInput(
    {
      projectId: record.project_id,
      repository: record.repository,
      mainSha: record.main_sha,
      productionSha: record.production_sha,
      deployImpact: record.deploy_impact,
      runtime: record.runtime,
      health: record.health,
      rollback: record.rollback,
      blockerCodes,
      observedAt: observedAt.value,
      productionAdapter: record.production_adapter,
      drift: record.drift,
    },
    "INVALID_STORED_ROW",
  );

  return { visibility, storedAt: storedAt.value };
}

export class D1Rpi5ProductionVisibilityStore {
  constructor(private readonly database: D1DatabaseLike) {}

  async persist(
    visibilityInput: unknown,
    storedAtInput: unknown,
  ): Promise<Rpi5ProductionVisibilityWriteResult> {
    const visibility = normalizeVisibilityInput(visibilityInput, "INVALID_INPUT");
    const observedAt = requireCanonicalTimestamp(visibility.observedAt, "INVALID_INPUT");
    const storedAt = requireCanonicalTimestamp(storedAtInput, "INVALID_INPUT");
    if (storedAt.milliseconds < observedAt.milliseconds) fail("INVALID_INPUT");

    const blockerCodesJson = JSON.stringify(visibility.blockerCodes);
    if (new TextEncoder().encode(blockerCodesJson).byteLength > MAX_BLOCKER_CODES_JSON_BYTES) {
      fail("INVALID_INPUT");
    }

    const result = await runWrite(this.database, [
      visibility.projectId,
      visibility.repository,
      visibility.mainSha,
      visibility.productionSha,
      visibility.deployImpact,
      visibility.runtime,
      visibility.health,
      visibility.rollback,
      blockerCodesJson,
      observedAt.value,
      observedAt.milliseconds,
      visibility.productionAdapter,
      visibility.drift,
      storedAt.value,
      storedAt.milliseconds,
    ]);

    if (result.success !== true) fail("D1_FAILURE");
    if (result.meta?.changes === 1) return "STORED";
    if (result.meta?.changes === 0) return "NOT_NEWER";
    fail("D1_FAILURE");
  }

  async read(
    projectIdInput: unknown,
    repositoryInput: unknown,
  ): Promise<Rpi5ProductionVisibilityReadResult> {
    const identity = requireReadIdentity(projectIdInput, repositoryInput);
    const rows = requireSuccessfulRows(
      await runRead(this.database, identity.projectId, identity.repository),
    );
    if (rows.length === 0) return { kind: "NOT_FOUND" };
    if (rows.length !== 1) fail("INVALID_STORED_ROW");

    const stored = normalizeStoredRow(rows[0], identity.projectId, identity.repository);
    return {
      kind: "FOUND",
      visibility: stored.visibility,
      storedAt: stored.storedAt,
    };
  }
}
