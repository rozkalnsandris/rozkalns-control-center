const D1_SYSTEM_SCHEMA_PREFIXES = Object.freeze(["sqlite_", "d1_", "_cf_"]);
const SQLITE_SCHEMA_TYPES = new Set(["table", "index", "view", "trigger"]);

function hasSystemPrefix(value) {
  const normalized = value.toLowerCase();
  return D1_SYSTEM_SCHEMA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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
