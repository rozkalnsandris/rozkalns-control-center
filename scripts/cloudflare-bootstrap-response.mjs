export function normalizeVersionItems(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  if (!Array.isArray(result.items)) return null;
  return result.items;
}
