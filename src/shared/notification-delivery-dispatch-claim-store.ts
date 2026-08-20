import type { NotificationDeliveryDispatchAttempt } from "./notification-delivery-dispatch-attempt.js";

export type NotificationDeliveryDispatchClaimResult =
  | { readonly kind: "CLAIMED" }
  | { readonly kind: "ALREADY_CLAIMED" };

export interface NotificationDeliveryDispatchClaimStore {
  /**
   * Atomically reserve one exact provider-neutral dispatch attempt.
   *
   * `ALREADY_CLAIMED` is intentionally fail-closed: a caller must not invoke a
   * provider again because an earlier execution may already have crossed the
   * provider boundary even if durable result evidence is not yet available.
   */
  claim(
    attempt: NotificationDeliveryDispatchAttempt,
  ): Promise<NotificationDeliveryDispatchClaimResult>;
}
