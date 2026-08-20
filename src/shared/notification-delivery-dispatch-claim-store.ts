import type { NotificationDeliveryDispatchAttempt } from "./notification-delivery-dispatch-attempt.js";

export type NotificationDeliveryDispatchClaimResult =
  | { readonly kind: "CLAIMED" }
  | { readonly kind: "ALREADY_CLAIMED" };

export type NotificationDeliveryDispatchClaimEvidence =
  | { readonly kind: "NOT_CLAIMED" }
  | { readonly kind: "CLAIMED" };

export interface NotificationDeliveryDispatchClaimSnapshot {
  readonly schemaVersion: 1;
  readonly dispatchId: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly transitionId: string;
  readonly targetKey: string;
  readonly attemptedAt: string;
}

export type NotificationDeliveryDispatchClaimRecoveryEvidence =
  | { readonly kind: "NOT_CLAIMED" }
  | {
      readonly kind: "CLAIMED";
      readonly claim: NotificationDeliveryDispatchClaimSnapshot;
    };

export interface NotificationDeliveryDispatchClaimReader {
  /**
   * Read exact durable claim evidence without creating, expiring or reclaiming
   * anything. `CLAIMED` is evidence of a replay barrier, never resend permission.
   */
  read(
    attempt: NotificationDeliveryDispatchAttempt,
  ): Promise<NotificationDeliveryDispatchClaimEvidence>;
}

export interface NotificationDeliveryDispatchClaimRecoveryReader {
  /**
   * Recover immutable durable claim evidence from deterministic delivery/attempt
   * identity only. This exists for restart/crash reconciliation when the original
   * `attemptedAt` is no longer available in volatile caller state.
   *
   * A returned claim is a replay barrier. This method never expires, reclaims,
   * rewrites or otherwise turns an existing claim into resend permission.
   */
  readSnapshot(
    deliveryId: string,
    attemptNumber: number,
  ): Promise<NotificationDeliveryDispatchClaimRecoveryEvidence>;
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
