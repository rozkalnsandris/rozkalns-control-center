const D1_SYSTEM_SCHEMA_PREFIXES = Object.freeze(["sqlite_", "d1_", "_cf_"]);
const SQLITE_SCHEMA_TYPES = new Set(["table", "index", "view", "trigger"]);
const CANONICAL_D1_MIGRATIONS_SQL = 'CREATE TABLE "d1_migrations"( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL )';

function hasSystemPrefix(value) {
  const normalized = value.toLowerCase();
  return D1_SYSTEM_SCHEMA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizeSql(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
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

export function classifyD1MigrationBootstrapSchemaRows(rows) {
  if (!Array.isArray(rows)) return { valid: false, present: false };
  if (rows.length === 0) return { valid: true, present: false };
  if (rows.length !== 2) return { valid: false, present: true };

  const table = rows.find((row) => row?.type === "table" && row?.name === "d1_migrations" && row?.tbl_name === "d1_migrations");
  const index = rows.find((row) => row?.type === "index" && row?.name === "sqlite_autoindex_d1_migrations_1" && row?.tbl_name === "d1_migrations");

  if (!table || !index) return { valid: false, present: true };
  if (normalizeSql(table.sql) !== CANONICAL_D1_MIGRATIONS_SQL) return { valid: false, present: true };
  if (index.sql !== null) return { valid: false, present: true };

  return { valid: true, present: true };
}
