import type {
  NotificationDeliveryAttemptHistory,
  NotificationDeliveryAttemptRecord,
} from "./notification-delivery-attempt.js";

export type NotificationDeliveryAttemptAppendResult =
  | { readonly kind: "APPENDED" }
  | { readonly kind: "DUPLICATE" };

export interface NotificationDeliveryAttemptStore {
  readHistory(deliveryId: string): Promise<NotificationDeliveryAttemptHistory>;

  append(
    attempt: NotificationDeliveryAttemptRecord,
  ): Promise<NotificationDeliveryAttemptAppendResult>;
}
