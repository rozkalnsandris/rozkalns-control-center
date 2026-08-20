import type { NotificationDeliveryDispatchAttempt } from "./notification-delivery-dispatch-attempt.js";

export type NotificationDeliveryDispatchClaimResult =
  | { readonly kind: "CLAIMED" }
  | { readonly kind: "ALREADY_CLAIMED" };

export type NotificationDeliveryDispatchClaimEvidence =
  | { readonly kind: "NOT_CLAIMED" }
  | { readonly kind: "CLAIMED" };

export interface NotificationDeliveryDispatchClaimReader {
  /**
   * Read exact durable claim evidence without creating, expiring or reclaiming
   * anything. `CLAIMED` is evidence of a replay barrier, never resend permission.
   */
  read(
    attempt: NotificationDeliveryDispatchAttempt,
  ): Promise<NotificationDeliveryDispatchClaimEvidence>;
}

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
