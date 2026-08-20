import type { NotificationCandidate, NotificationSignal } from "./notification-transition.js";
import { sanitizeNotificationText } from "./notification-transition.js";

export type NotificationDeliveryTargetKey = string;

export interface NotificationDeliveryEnvelope {
  readonly schemaVersion: 1;
  readonly deliveryId: string;
  readonly targetKey: NotificationDeliveryTargetKey;
  readonly transitionId: string;
  readonly signal: NotificationSignal;
  readonly decisionId: string;
  readonly projectId: string;
  readonly reference: string;
  readonly title: string;
  readonly body: string;
  readonly deepLinkPath: string;
}

export type NotificationDeliveryRetryReason =
  | "RATE_LIMITED"
  | "TRANSIENT_UPSTREAM"
  | "PROVIDER_UNAVAILABLE";

export type NotificationDeliveryTerminalReason =
  | "DESTINATION_INVALID"
  | "PAYLOAD_REJECTED"
  | "AUTHORIZATION_FAILED";

export type NotificationDeliveryResult =
  | { readonly kind: "DELIVERED" }
  | {
      readonly kind: "RETRYABLE_FAILURE";
      readonly reason: NotificationDeliveryRetryReason;
    }
  | {
      readonly kind: "TERMINAL_FAILURE";
      readonly reason: NotificationDeliveryTerminalReason;
    };

export interface NotificationDeliveryAdapter {
  deliver(envelope: NotificationDeliveryEnvelope): Promise<NotificationDeliveryResult>;
}

export type NotificationDeliveryContractErrorCode =
  | "INVALID_TARGET_KEY"
  | "INVALID_CANDIDATE";

export class NotificationDeliveryContractError extends Error {
  readonly code: NotificationDeliveryContractErrorCode;

  constructor(code: NotificationDeliveryContractErrorCode) {
    super("Notification delivery contract validation failed");
    this.name = "NotificationDeliveryContractError";
    this.code = code;
  }
}

const TARGET_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,63})$/;
const TRANSITION_ID_PATTERN = /^[a-z0-9-]+$/;
const TITLE_LIMIT = 160;
const BODY_LIMIT = 280;
const REFERENCE_LIMIT = 80;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

function characterLength(value: string): number {
  return Array.from(value).length;
}

function validBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    characterLength(value) >= minimum &&
    characterLength(value) <= maximum
  );
}

function validSanitizedText(value: unknown, maximum: number): value is string {
  return (
    validBoundedString(value, 1, maximum) &&
    sanitizeNotificationText(value, maximum) === value
  );
}

function assertCandidate(candidate: NotificationCandidate): void {
  if (
    candidate.schemaVersion !== 1 ||
    (candidate.signal !== "NEEDS_ANDRIS" && candidate.signal !== "CI_FAILED") ||
    !validBoundedString(candidate.transitionId, 32, 80) ||
    !TRANSITION_ID_PATTERN.test(candidate.transitionId) ||
    !validBoundedString(candidate.decisionId, 1, 512) ||
    !validBoundedString(candidate.projectId, 1, 200) ||
    !validSanitizedText(candidate.reference, REFERENCE_LIMIT) ||
    !validSanitizedText(candidate.title, TITLE_LIMIT) ||
    !validSanitizedText(candidate.body, BODY_LIMIT) ||
    !validBoundedString(candidate.deepLinkPath, 12, 1200) ||
    !candidate.deepLinkPath.startsWith("/#decision-")
  ) {
    throw new NotificationDeliveryContractError("INVALID_CANDIDATE");
  }
}

function assertTargetKey(targetKey: NotificationDeliveryTargetKey): void {
  if (!TARGET_KEY_PATTERN.test(targetKey)) {
    throw new NotificationDeliveryContractError("INVALID_TARGET_KEY");
  }
}

function stableFingerprint(value: string): string {
  let hash = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

export function notificationDeliveryId(
  candidate: NotificationCandidate,
  targetKey: NotificationDeliveryTargetKey,
): string {
  assertCandidate(candidate);
  assertTargetKey(targetKey);
  return `delivery-v1-${stableFingerprint(
    JSON.stringify(["notification-delivery-v1", candidate.transitionId, targetKey]),
  )}`;
}

/**
 * Build the provider-neutral payload handed to a future delivery adapter.
 * `targetKey` is an opaque, bounded, non-secret routing label. Provider
 * credentials, destination tokens and privileged action tokens never belong in
 * this envelope.
 */
export function notificationDeliveryEnvelope(
  candidate: NotificationCandidate,
  targetKey: NotificationDeliveryTargetKey,
): NotificationDeliveryEnvelope {
  const deliveryId = notificationDeliveryId(candidate, targetKey);

  return {
    schemaVersion: 1,
    deliveryId,
    targetKey,
    transitionId: candidate.transitionId,
    signal: candidate.signal,
    decisionId: candidate.decisionId,
    projectId: candidate.projectId,
    reference: candidate.reference,
    title: candidate.title,
    body: candidate.body,
    deepLinkPath: candidate.deepLinkPath,
  };
}

export function notificationDeliveryShouldRetry(result: NotificationDeliveryResult): boolean {
  return result.kind === "RETRYABLE_FAILURE";
}
