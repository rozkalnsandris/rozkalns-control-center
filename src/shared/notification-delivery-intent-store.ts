import type { NotificationDeliveryEnvelope } from "./notification-delivery.js";

export interface NotificationDeliveryIntent {
  readonly envelope: NotificationDeliveryEnvelope;
  readonly queuedAt: string;
}

export type NotificationDeliveryIntentEnqueueResult =
  | { readonly kind: "ENQUEUED" }
  | { readonly kind: "DUPLICATE" };

export interface NotificationDeliveryIntentStore {
  enqueue(
    intent: NotificationDeliveryIntent,
  ): Promise<NotificationDeliveryIntentEnqueueResult>;
}
