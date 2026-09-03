export const NOTIFICATION_DELIVERY_DISPATCH_QUEUE_MESSAGE_VERSION = 1 as const;
export const NOTIFICATION_DELIVERY_DISPATCH_QUEUE_MESSAGE_KIND =
  "NOTIFICATION_DELIVERY_DISPATCH" as const;

export interface NotificationDeliveryDispatchQueueMessageV1 {
  readonly schemaVersion: typeof NOTIFICATION_DELIVERY_DISPATCH_QUEUE_MESSAGE_VERSION;
  readonly kind: typeof NOTIFICATION_DELIVERY_DISPATCH_QUEUE_MESSAGE_KIND;
  readonly deliveryId: string;
}

const DELIVERY_ID_PATTERN = /^delivery-v1-[0-9a-f]{16}$/;
const allowedKeys = new Set<keyof NotificationDeliveryDispatchQueueMessageV1>([
  "schemaVersion",
  "kind",
  "deliveryId",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Notification delivery dispatch Queue message must be an object");
  }
  return value as Record<string, unknown>;
}

function deliveryId(value: unknown): string {
  if (typeof value !== "string" || !DELIVERY_ID_PATTERN.test(value)) {
    throw new Error("Notification delivery dispatch Queue deliveryId is malformed");
  }
  return value;
}

/**
 * Create the minimal provider-neutral Queue message used to recover a durable
 * notification intent. Provider credentials, destination identifiers, payload
 * text and retry state never belong in the Queue body.
 */
export function createNotificationDeliveryDispatchQueueMessage(
  deliveryIdInput: string,
): NotificationDeliveryDispatchQueueMessageV1 {
  return {
    schemaVersion: NOTIFICATION_DELIVERY_DISPATCH_QUEUE_MESSAGE_VERSION,
    kind: NOTIFICATION_DELIVERY_DISPATCH_QUEUE_MESSAGE_KIND,
    deliveryId: deliveryId(deliveryIdInput),
  };
}

export function parseNotificationDeliveryDispatchQueueMessage(
  input: unknown,
): NotificationDeliveryDispatchQueueMessageV1 {
  const message = record(input);
  for (const key of Object.keys(message)) {
    if (!allowedKeys.has(key as keyof NotificationDeliveryDispatchQueueMessageV1)) {
      throw new Error(`Unsupported notification delivery dispatch Queue field: ${key}`);
    }
  }

  if (message.schemaVersion !== NOTIFICATION_DELIVERY_DISPATCH_QUEUE_MESSAGE_VERSION) {
    throw new Error("Unsupported notification delivery dispatch Queue schema version");
  }
  if (message.kind !== NOTIFICATION_DELIVERY_DISPATCH_QUEUE_MESSAGE_KIND) {
    throw new Error("Unsupported notification delivery dispatch Queue message kind");
  }

  return createNotificationDeliveryDispatchQueueMessage(deliveryId(message.deliveryId));
}
