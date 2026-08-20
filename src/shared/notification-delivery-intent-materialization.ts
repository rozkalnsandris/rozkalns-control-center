import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
  type NotificationDeliveryTargetKey,
} from "./notification-delivery.js";
import type {
  NotificationDeliveryIntentEnqueueResult,
  NotificationDeliveryIntentStore,
} from "./notification-delivery-intent-store.js";
import type { NotificationCandidate } from "./notification-transition.js";

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const NOTIFICATION_DELIVERY_INTENT_MAX_TARGETS = 16 as const;

export interface NotificationDeliveryIntentMaterializationInput {
  readonly candidate: NotificationCandidate;
  readonly queuedAt: string;
  readonly targetKeys: readonly NotificationDeliveryTargetKey[];
}

export interface NotificationDeliveryIntentMaterializationPlan {
  readonly queuedAt: string;
  readonly envelopes: readonly NotificationDeliveryEnvelope[];
}

export interface NotificationDeliveryIntentMaterializationEvidence {
  readonly targetKey: NotificationDeliveryTargetKey;
  readonly deliveryId: string;
  readonly result: NotificationDeliveryIntentEnqueueResult["kind"];
}

export interface NotificationDeliveryIntentMaterializationResult {
  readonly intents: readonly NotificationDeliveryIntentMaterializationEvidence[];
  readonly enqueued: number;
  readonly duplicates: number;
}

export type NotificationDeliveryIntentMaterializationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_QUEUED_AT"
  | "INVALID_TARGET_SET"
  | "INVALID_STORE_RESULT";

export class NotificationDeliveryIntentMaterializationError extends Error {
  readonly code: NotificationDeliveryIntentMaterializationErrorCode;

  constructor(code: NotificationDeliveryIntentMaterializationErrorCode) {
    super("Notification delivery intent materialization failed");
    this.name = "NotificationDeliveryIntentMaterializationError";
    this.code = code;
  }
}

function requireQueuedAt(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new NotificationDeliveryIntentMaterializationError("INVALID_QUEUED_AT");
  }

  return new Date(value).toISOString();
}

function requireTargetKeys(value: unknown): readonly NotificationDeliveryTargetKey[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > NOTIFICATION_DELIVERY_INTENT_MAX_TARGETS
  ) {
    throw new NotificationDeliveryIntentMaterializationError("INVALID_TARGET_SET");
  }

  const targetKeys: NotificationDeliveryTargetKey[] = [];
  const seen = new Set<string>();

  for (const targetKey of value) {
    if (typeof targetKey !== "string" || seen.has(targetKey)) {
      throw new NotificationDeliveryIntentMaterializationError("INVALID_TARGET_SET");
    }
    seen.add(targetKey);
    targetKeys.push(targetKey);
  }

  return targetKeys;
}

/**
 * Prevalidate one provider-neutral delivery-intent batch without mutating a
 * durable store. Higher-level reconciliation can use this before claiming any
 * transition so a malformed later candidate/target cannot strand a partial
 * transition→intent composition.
 */
export function prepareNotificationDeliveryIntentMaterialization(
  input: NotificationDeliveryIntentMaterializationInput,
): NotificationDeliveryIntentMaterializationPlan {
  if (!input || typeof input !== "object") {
    throw new NotificationDeliveryIntentMaterializationError("INVALID_INPUT");
  }

  const queuedAt = requireQueuedAt(input.queuedAt);
  const targetKeys = requireTargetKeys(input.targetKeys);
  const envelopes = targetKeys.map((targetKey) =>
    notificationDeliveryEnvelope(input.candidate, targetKey),
  );

  return { queuedAt, envelopes };
}

/**
 * Materialize durable provider-neutral delivery intents for one already-selected
 * notification candidate and an explicit finite caller-supplied target set.
 *
 * All candidate, timestamp and target evidence is validated before the first
 * durable enqueue. Enqueues are deliberately sequential so a partial failure
 * leaves earlier durable intents intact; a later higher-level replay relies on
 * the existing exact DUPLICATE semantics rather than compensation or rewrite.
 * Materialization creates durable intent evidence only and is not provider-send
 * permission.
 */
export async function materializeNotificationDeliveryIntents(
  input: NotificationDeliveryIntentMaterializationInput,
  store: NotificationDeliveryIntentStore,
): Promise<NotificationDeliveryIntentMaterializationResult> {
  if (!store || typeof store.enqueue !== "function") {
    throw new NotificationDeliveryIntentMaterializationError("INVALID_INPUT");
  }

  const { queuedAt, envelopes } = prepareNotificationDeliveryIntentMaterialization(input);
  const intents: NotificationDeliveryIntentMaterializationEvidence[] = [];
  let enqueued = 0;
  let duplicates = 0;

  for (const envelope of envelopes) {
    const result = await store.enqueue({ envelope, queuedAt });
    if (
      !result ||
      typeof result !== "object" ||
      (result.kind !== "ENQUEUED" && result.kind !== "DUPLICATE")
    ) {
      throw new NotificationDeliveryIntentMaterializationError("INVALID_STORE_RESULT");
    }

    if (result.kind === "ENQUEUED") enqueued += 1;
    else duplicates += 1;

    intents.push({
      targetKey: envelope.targetKey,
      deliveryId: envelope.deliveryId,
      result: result.kind,
    });
  }

  return { intents, enqueued, duplicates };
}
