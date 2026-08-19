const DECISION_TARGET_PREFIX = "decision-" as const;
const DECISION_TARGET_PATTERN = /^decision-(?:empty|(?:[0-9a-f]{2})+)$/;

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decisionTargetId(decisionId: string): string {
  const encoded = utf8Hex(decisionId);
  return `${DECISION_TARGET_PREFIX}${encoded || "empty"}`;
}

export function decisionDeepLinkHash(decisionId: string): string {
  return `#${decisionTargetId(decisionId)}`;
}

export function decisionDeepLinkPath(decisionId: string): string {
  return `/${decisionDeepLinkHash(decisionId)}`;
}

export function decisionTargetIdFromHash(hash: string): string | null {
  if (!hash.startsWith("#")) return null;
  const targetId = hash.slice(1);
  return DECISION_TARGET_PATTERN.test(targetId) ? targetId : null;
}
