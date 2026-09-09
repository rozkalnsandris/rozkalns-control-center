import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml";

const EXPECTED_0010_INDEX_SQL =
  "create index idx_webhook_deliveries_active_updated_delivery on webhook_deliveries (updated_at, delivery_id) where state <> 'succeeded'";

function normalizeSchemaSql(sql: string): string {
  return sql.trim().toLowerCase().replace(/\s+/g, " ");
}

function workflowSource(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

test("Phase 5 observation preflight is manually dispatched and read-only scoped", () => {
  const source = workflowSource();

  assert.match(source, /name: Phase 5 RPi5 observation GET\/SELECT-only preflight/);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /permissions:\n {2}contents: read\n {2}actions: read/);
  assert.match(source, /environment: production-readonly-reconcile/);
  assert.match(source, /CLOUDFLARE_D1_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_READ_TOKEN \}\}/);
  assert.match(source, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
});

test("D1 preflight admits only single SELECT statements and proves zero mutation", () => {
  const source = workflowSource();

  assert.match(source, /\[\[ "\$sql" == SELECT\\ \* \]\] \|\| stop D1_QUERY_NOT_SELECT/);
  assert.match(source, /\[\[ "\$sql" != \*';'\* \]\] \|\| stop D1_QUERY_MULTISTATEMENT_FORBIDDEN/);
  assert.match(source, /\.meta\.changed_db \/\/ false\) == false/);
  assert.match(source, /\.meta\.rows_written \/\/ 0/);
  assert.match(source, /\.meta\.changes \/\/ 0/);
  assert.equal((source.match(/-X POST/g) ?? []).length, 1);
  assert.match(source, /\/d1\/database\/\$\{DB_ID\}\/query/);

  for (const forbiddenMethod of [/-X PUT/, /-X PATCH/, /-X DELETE/]) {
    assert.doesNotMatch(source, forbiddenMethod);
  }
});

test("preflight requires dormant ingest and never reads protected verification-key content", () => {
  const source = workflowSource();

  assert.match(source, /CONTROL_RPI5_OBSERVATION_INGEST_ENABLED/);
  assert.match(source, /stop INGEST_ALREADY_ACTIVE/);
  assert.match(source, /CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS/);
  assert.match(source, /key_status=PRESENT_PROTECTED/);
  assert.match(source, /VERIFICATION_KEY_BINDING_INVALID_OR_EXPOSED/);

  const keyBindingLines = source
    .split("\n")
    .filter((line) => line.includes("CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS"));
  assert.equal(keyBindingLines.some((line) => /\.text\b/.test(line)), false);
  assert.equal(keyBindingLines.some((line) => /fromjson/.test(line)), false);
});

test("preflight classifies predecessor migration 0010 and its exact partial index", () => {
  const source = workflowSource();

  assert.match(source, /0010_webhook_observability_hot_index\.sql/);
  assert.match(source, /idx_webhook_deliveries_active_updated_delivery/);
  assert.match(source, /D1_0010_MIGRATION=%s/);
  assert.match(source, /D1_0010_INDEX=%s/);
  assert.match(source, /D1_0010_MIGRATION_HISTORY_INVALID/);
  assert.match(source, /D1_0010_INDEX_PRESENT_WITHOUT_MIGRATION/);
  assert.match(source, /D1_0010_INDEX_INVALID/);
  assert.match(source, /tbl_name == "webhook_deliveries"/);
  assert.match(source, /updated_at, delivery_id/);
  assert.match(source, /where state <> 'succeeded'/);
  assert.match(source, /for cmd in curl jq node; do/);
  assert.ok(source.includes('String(value ?? "").trim().toLowerCase().replace(/\\s+/g, " ")'));
  assert.doesNotMatch(source, /ascii_downcase/);
});

test("preflight index SQL normalization ignores formatting whitespace but preserves reviewed semantics", () => {
  const equivalent = `\uFEFF\nCREATE INDEX idx_webhook_deliveries_active_updated_delivery\n  ON webhook_deliveries (updated_at, delivery_id)\n  WHERE state <> 'SUCCEEDED'\n   `;
  const differentPredicate = `CREATE INDEX idx_webhook_deliveries_active_updated_delivery
    ON webhook_deliveries (updated_at, delivery_id)
    WHERE state = 'SUCCEEDED'`;

  assert.equal(normalizeSchemaSql(equivalent), EXPECTED_0010_INDEX_SQL);
  assert.notEqual(normalizeSchemaSql(differentPredicate), EXPECTED_0010_INDEX_SQL);
});

test("preflight classifies Phase 5 migration history as all absent or all present", () => {
  const source = workflowSource();

  for (const migration of [
    "0011_rpi5_observation_replay_claims.sql",
    "0012_rpi5_production_visibility_projection.sql",
    "0013_rpi5_observation_atomic_acceptance.sql",
  ]) {
    assert.match(source, new RegExp(migration.replaceAll(".", "\\.")));
  }
  assert.match(source, /migration_status=ABSENT/);
  assert.match(source, /migration_status=PRESENT/);
  assert.match(source, /D1_PHASE5_MIGRATION_HISTORY_PARTIAL_OR_INVALID/);
  assert.match(source, /D1_PHASE5_SCHEMA_PRESENT_WITHOUT_MIGRATIONS/);
  assert.match(source, /replay_key, replay_expires_at_ms, claimed_at_ms, claim_token/);
  assert.match(source, /project_id, repository, observed_at_ms, stored_at_ms/);
});

test("preflight contains no deployment, migration-apply, secret-write, queue or RPi5 mutation command", () => {
  const source = workflowSource();

  for (const forbidden of [
    /wrangler\s+deploy/i,
    /wrangler\s+d1\s+migrations\s+apply/i,
    /wrangler\s+secret\s+put/i,
    /wrangler\s+queues?\s+/i,
    /\/deployments[^"'\n]*\s+-X\s+POST/i,
    /api\.telegram\.org/i,
    /\bssh\b/i,
    /\bsudo\b/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }

  for (const marker of [
    "RPI5_REQUEST=NO",
    "QUEUE_MUTATION=NO",
    "REMOTE_D1_MUTATION=NO",
    "WORKER_MUTATION=NO",
    "CLOUDFLARE_CONFIG_MUTATION=NO",
    "SECRET_MUTATION=NO",
    "CLOUDFLARE_MUTATION=NO",
    "LIVE_AUTHORIZATION=NOT_GRANTED",
  ]) {
    assert.match(source, new RegExp(marker));
  }
});