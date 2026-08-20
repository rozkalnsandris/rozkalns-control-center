import type { ControlDashboardData } from "./control-model.js";
import {
  materializeNotificationDeliveryIntents,
  prepareNotificationDeliveryIntentMaterialization,
  type NotificationDeliveryIntentMaterializationInput,
} from "./notification-delivery-intent-materialization.js";
import type { NotificationDeliveryTargetKey } from "./notification-delivery.js";
import type { NotificationDeliveryIntentStore } from "./notification-delivery-intent-store.js";
import {
  notificationCandidateForDecision,
  notificationSignalForDecision,
  type NotificationCandidate,
} from "./notification-transition.js";
import type {
  NotificationTransitionClaimResult,
  NotificationTransitionStore,
} from "./notification-transition-store.js";

export interface NotificationTransitionDeliveryReconciliationInput {
  readonly snapshot: ControlDashboardData;
  readonly observedAt: string;
  readonly targetKeys: readonly NotificationDeliveryTargetKey[];
}

export interface NotificationTransitionDeliveryReconciliationSummary {
  readonly transitions: {
    readonly claimed: number;
    readonly duplicates: number;
    readonly ignored: number;
  };
  readonly intents: {
    readonly enqueued: number;
    readonly duplicates: number;
  };
}

export type NotificationTransitionDeliveryReconciliationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TRANSITION_STORE_RESULT";

export class NotificationTransitionDeliveryReconciliationError extends Error {
  readonly code: NotificationTransitionDeliveryReconciliationErrorCode;

  constructor(code: NotificationTransitionDeliveryReconciliationErrorCode) {
    super("Notification transition delivery reconciliation failed");
    this.name = "NotificationTransitionDeliveryReconciliationError";
    this.code = code;
  }
}

interface PreparedCandidate {
  readonly candidate: NotificationCandidate;
  readonly materialization: NotificationDeliveryIntentMaterializationInput;
}

function requireTransitionResult(
  value: NotificationTransitionClaimResult,
): NotificationTransitionClaimResult {
  if (
    !value ||
    typeof value !== "object" ||
    (value.kind !== "CLAIMED" && value.kind !== "DUPLICATE")
  ) {
    throw new NotificationTransitionDeliveryReconciliationError(
      "INVALID_TRANSITION_STORE_RESULT",
    );
  }
  return value;
}

/**
 * Reconcile high-signal transition discovery into durable delivery intents
 * without selecting or invoking any notification provider.
 *
 * Every high-signal candidate and its complete explicit target set is
 * prevalidated before the first durable claim. A transition DUPLICATE is replay
 * evidence, not a reason to skip materialization: if an earlier invocation
 * persisted the transition but failed part-way through intent enqueue, the next
 * invocation must retry the exact deterministic intents. Already durable intents
 * become DUPLICATE and missing intents are created. No compensation or delete is
 * attempted after partial failure.
 */
export async function reconcileNotificationTransitionDeliveries(
  input: NotificationTransitionDeliveryReconciliationInput,
  transitionStore: NotificationTransitionStore,
  intentStore: NotificationDeliveryIntentStore,
): Promise<NotificationTransitionDeliveryReconciliationSummary> {
  if (
    !input ||
    typeof input !== "object" ||
    !input.snapshot ||
    !Array.isArray(input.snapshot.decisions) ||
    !transitionStore ||
    typeof transitionStore.claim !== "function" ||
    !intentStore ||
    typeof intentStore.enqueue !== "function"
  ) {
    throw new NotificationTransitionDeliveryReconciliationError("INVALID_INPUT");
  }

  const prepared: PreparedCandidate[] = [];
  let ignored = 0;

  // Build and validate the complete high-signal work set before the first
  // transition claim or delivery-intent enqueue.
  for (const decision of input.snapshot.decisions) {
    const signal = notificationSignalForDecision(decision);
    if (signal === null) {
      ignored += 1;
      continue;
    }

    const candidate = notificationCandidateForDecision(decision, signal);
    const materialization: NotificationDeliveryIntentMaterializationInput = {
      candidate,
      queuedAt: input.observedAt,
      targetKeys: input.targetKeys,
    };
    prepareNotificationDeliveryIntentMaterialization(materialization);
    prepared.push({ candidate, materialization });
  }

  let claimed = 0;
  let transitionDuplicates = 0;
  let intentEnqueued = 0;
  let intentDuplicates = 0;

  for (const work of prepared) {
    const transitionResult = requireTransitionResult(
      await transitionStore.claim({
        candidate: work.candidate,
        claimedAt: input.observedAt,
      }),
    );

    if (transitionResult.kind === "CLAIMED") claimed += 1;
    else transitionDuplicates += 1;

    // Intentionally materialize after BOTH CLAIMED and DUPLICATE. A duplicate
    // transition can be the durable evidence left by an interrupted prior run.
    const materialized = await materializeNotificationDeliveryIntents(
      work.materialization,
      intentStore,
    );
    intentEnqueued += materialized.enqueued;
    intentDuplicates += materialized.duplicates;
  }

  return {
    transitions: {
      claimed,
      duplicates: transitionDuplicates,
      ignored,
    },
    intents: {
      enqueued: intentEnqueued,
      duplicates: intentDuplicates,
    },
  };
}
