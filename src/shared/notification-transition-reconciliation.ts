import type { ControlDashboardData } from "./control-model.js";
import {
  notificationCandidateForDecision,
  notificationSignalForDecision,
} from "./notification-transition.js";
import type { NotificationTransitionStore } from "./notification-transition-store.js";

export interface NotificationTransitionReconciliationSummary {
  readonly claimed: number;
  readonly duplicates: number;
  readonly ignored: number;
}

/**
 * Discover durable high-signal transitions from one authoritative dashboard
 * snapshot. This records transition discovery only; it does not represent or
 * trigger provider delivery.
 *
 * Claims are deliberately sequential. If a later claim fails, earlier claims
 * remain durable and become DUPLICATE on Queue retry, preserving idempotency
 * while the failed reconciliation remains retryable.
 */
export async function reconcileNotificationTransitions(
  snapshot: ControlDashboardData,
  store: NotificationTransitionStore,
  claimedAt: string,
): Promise<NotificationTransitionReconciliationSummary> {
  let claimed = 0;
  let duplicates = 0;
  let ignored = 0;

  for (const decision of snapshot.decisions) {
    const signal = notificationSignalForDecision(decision);
    if (signal === null) {
      ignored += 1;
      continue;
    }

    const result = await store.claim({
      candidate: notificationCandidateForDecision(decision, signal),
      claimedAt,
    });

    if (result.kind === "CLAIMED") claimed += 1;
    else duplicates += 1;
  }

  return { claimed, duplicates, ignored };
}
