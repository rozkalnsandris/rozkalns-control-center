import type { NotificationDeliveryEnvelope } from "./notification-delivery.js";

export interface NotificationDeliveryIntent {
  readonly envelope: NotificationDeliveryEnvelope;
  readonly queuedAt: string;
}

export type NotificationDeliveryIntentEnqueueResult =
  | { readonly kind: "ENQUEUED" }
  | { readonly kind: "DUPLICATE" };

export type NotificationDeliveryIntentRecoveryEvidence =
  | { readonly kind: "NOT_FOUND" }
  | {
      readonly kind: "FOUND";
      readonly intent: NotificationDeliveryIntent;
    };

export interface NotificationDeliveryIntentRecoveryReader {
  /**
   * Recover one immutable durable delivery intent by deterministic delivery ID.
   *
   * `FOUND` is evidence only, not provider-send permission. `NOT_FOUND` does not
   * authorize recreation, resend or any mutation; later orchestration must still
   * apply dispatch decision and replay-safety gates.
   */
  read(deliveryId: string): Promise<NotificationDeliveryIntentRecoveryEvidence>;
}

export interface NotificationDeliveryIntentStore {
  enqueue(
    intent: NotificationDeliveryIntent,
  ): Promise<NotificationDeliveryIntentEnqueueResult>;
}
