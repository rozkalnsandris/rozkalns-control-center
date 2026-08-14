const D1_SYSTEM_SCHEMA_PREFIXES = Object.freeze(["sqlite_", "d1_", "_cf_"]);
const SQLITE_SCHEMA_TYPES = new Set(["table", "index", "view", "trigger"]);
const REVIEWED_APPLICATION_SCHEMA_NAMES = new Set([
  "webhook_deliveries",
  "idx_webhook_deliveries_repository_updated_at",
  "idx_webhook_deliveries_state_updated_at",
]);
const CANONICAL_D1_MIGRATIONS_SQL =
  'CREATE TABLE "d1_migrations"( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL )';

function hasSystemPrefix(value) {
  const normalized = value.toLowerCase();
  return D1_SYSTEM_SCHEMA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizeSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

export function classifyInitialD1SchemaRows(rows) {
  if (!Array.isArray(rows)) return { valid: false, unexpected: [] };

  const unexpected = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return { valid: false, unexpected: [] };
    }

    const { type, name, tbl_name: tableName } = row;
    if (
      typeof type !== "string" ||
      !SQLITE_SCHEMA_TYPES.has(type) ||
      typeof name !== "string" ||
      name.length === 0 ||
      typeof tableName !== "string" ||
      tableName.length === 0
    ) {
      return { valid: false, unexpected: [] };
    }

    if (!hasSystemPrefix(tableName)) {
      unexpected.push({ type, name, tbl_name: tableName });
    }
  }

  return { valid: true, unexpected };
}

export function classifyInitialD1MigrationBootstrap(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, state: "INVALID", reason: "EVIDENCE_INVALID" };
  }

  const { schemaRows, historyRows } = input;
  if (!Array.isArray(schemaRows)) {
    return { valid: false, state: "INVALID", reason: "EVIDENCE_INVALID" };
  }

  const migrationRows = [];
  for (const row of schemaRows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return { valid: false, state: "INVALID", reason: "EVIDENCE_INVALID" };
    }

    const { type, name, tbl_name: tableName, sql } = row;
    if (
      typeof type !== "string" ||
      !SQLITE_SCHEMA_TYPES.has(type) ||
      typeof name !== "string" ||
      name.length === 0 ||
      typeof tableName !== "string" ||
      tableName.length === 0 ||
      !(sql === null || typeof sql === "string")
    ) {
      return { valid: false, state: "INVALID", reason: "EVIDENCE_INVALID" };
    }

    if (REVIEWED_APPLICATION_SCHEMA_NAMES.has(name) || tableName === "webhook_deliveries") {
      return { valid: false, state: "INVALID", reason: "APPLICATION_SCHEMA_PRESENT" };
    }

    if (name === "d1_migrations" || tableName === "d1_migrations") {
      migrationRows.push(row);
    }
  }

  if (migrationRows.length === 0) {
    if (historyRows !== null) {
      return { valid: false, state: "INVALID", reason: "EVIDENCE_INVALID" };
    }
    return { valid: true, state: "ABSENT", reason: null };
  }

  if (migrationRows.length !== 2 || !Array.isArray(historyRows)) {
    return { valid: false, state: "INVALID", reason: "MIGRATION_SCHEMA_INVALID" };
  }

  const table = migrationRows.find(
    (row) => row.type === "table" && row.name === "d1_migrations" && row.tbl_name === "d1_migrations",
  );
  const autoIndex = migrationRows.find(
    (row) =>
      row.type === "index" &&
      row.name === "sqlite_autoindex_d1_migrations_1" &&
      row.tbl_name === "d1_migrations",
  );

  if (
    !table ||
    typeof table.sql !== "string" ||
    normalizeSql(table.sql) !== CANONICAL_D1_MIGRATIONS_SQL ||
    !autoIndex ||
    autoIndex.sql !== null
  ) {
    return { valid: false, state: "INVALID", reason: "MIGRATION_SCHEMA_INVALID" };
  }

  for (const row of historyRows) {
    if (row === null || typeof row !== "object" || Array.isArray(row) || typeof row.name !== "string" || row.name.length === 0) {
      return { valid: false, state: "INVALID", reason: "EVIDENCE_INVALID" };
    }
  }
  if (historyRows.length !== 0) {
    return { valid: false, state: "INVALID", reason: "MIGRATION_HISTORY_NOT_EMPTY" };
  }

  return { valid: true, state: "CANONICAL_EMPTY_HISTORY", reason: null };
}
