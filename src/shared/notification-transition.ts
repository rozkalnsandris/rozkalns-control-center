import type { DecisionReadModel } from "./control-model.js";
import { decisionDeepLinkPath } from "./decision-deep-link.js";

export type NotificationSignal = "NEEDS_ANDRIS" | "CI_FAILED";

export interface NotificationCandidate {
  schemaVersion: 1;
  signal: NotificationSignal;
  transitionId: string;
  decisionId: string;
  projectId: string;
  reference: string;
  title: string;
  body: string;
  deepLinkPath: string;
}

export type NotificationTransitionResult =
  | {
      kind: "NO_SIGNAL";
      reason: "LOW_SIGNAL" | "UNCHANGED";
    }
  | {
      kind: "NEW_TRANSITION";
      candidate: NotificationCandidate;
    };

const TITLE_LIMIT = 160;
const BODY_LIMIT = 280;
const REFERENCE_LIMIT = 80;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

export function sanitizeNotificationText(value: string | null | undefined, maxLength: number): string {
  const normalized = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return Array.from(normalized).slice(0, maxLength).join("");
}

export function notificationSignalForDecision(item: DecisionReadModel): NotificationSignal | null {
  if (item.workflowState === "NEEDS_ANDRIS") return "NEEDS_ANDRIS";
  if (item.workflowState === "CI_FAILED" && item.ci === "FAIL") return "CI_FAILED";
  return null;
}

function stableFingerprint(value: string): string {
  let hash = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function notificationMaterialState(item: DecisionReadModel, signal: NotificationSignal): string {
  return JSON.stringify([
    "notification-transition-v1",
    signal,
    item.id,
    item.projectId,
    item.workflowState,
    item.ci,
    item.review,
    item.deployImpact,
    item.issueNumber,
    sanitizeNotificationText(item.issueTitle, TITLE_LIMIT),
    item.prNumber,
    sanitizeNotificationText(item.prTitle, TITLE_LIMIT),
    item.changedFiles,
    item.expectedHeadSha,
    item.currentHeadSha,
    item.mainSha,
    sanitizeNotificationText(item.reason, BODY_LIMIT),
  ]);
}

export function notificationTransitionId(
  item: DecisionReadModel,
  signal: NotificationSignal,
): string {
  const digest = stableFingerprint(notificationMaterialState(item, signal));
  return `notification-v1-${signal.toLowerCase().replace("_", "-")}-${digest}`;
}

function referenceLabel(item: DecisionReadModel): string {
  if (item.prNumber !== null) return `PR #${item.prNumber}`;
  if (item.issueNumber !== null) return `Issue #${item.issueNumber}`;
  return "Decision";
}

function fallbackBody(signal: NotificationSignal): string {
  return signal === "NEEDS_ANDRIS" ? "Needs Andris" : "CI failed";
}

export function notificationCandidateForDecision(
  item: DecisionReadModel,
  signal: NotificationSignal,
): NotificationCandidate {
  const reference = sanitizeNotificationText(referenceLabel(item), REFERENCE_LIMIT);
  const title = sanitizeNotificationText(
    item.prTitle ?? item.issueTitle ?? reference,
    TITLE_LIMIT,
  );
  const body = sanitizeNotificationText(item.reason, BODY_LIMIT) || fallbackBody(signal);

  return {
    schemaVersion: 1,
    signal,
    transitionId: notificationTransitionId(item, signal),
    decisionId: item.id,
    projectId: item.projectId,
    reference,
    title,
    body,
    deepLinkPath: decisionDeepLinkPath(item.id),
  };
}

export function evaluateNotificationTransition(
  previous: DecisionReadModel | null,
  current: DecisionReadModel,
): NotificationTransitionResult {
  const currentSignal = notificationSignalForDecision(current);
  if (currentSignal === null) {
    return { kind: "NO_SIGNAL", reason: "LOW_SIGNAL" };
  }

  if (previous !== null) {
    const previousSignal = notificationSignalForDecision(previous);
    if (
      previousSignal === currentSignal &&
      notificationTransitionId(previous, previousSignal) ===
        notificationTransitionId(current, currentSignal)
    ) {
      return { kind: "NO_SIGNAL", reason: "UNCHANGED" };
    }
  }

  return {
    kind: "NEW_TRANSITION",
    candidate: notificationCandidateForDecision(current, currentSignal),
  };
}
