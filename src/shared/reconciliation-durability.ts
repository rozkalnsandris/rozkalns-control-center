export type DeliveryLifecycleState =
  | "RECEIVED"
  | "ENQUEUED"
  | "PROCESSING"
  | "RETRY_PENDING"
  | "SUCCEEDED"
  | "DEAD_LETTERED";

const allowedTransitions: Readonly<Record<DeliveryLifecycleState, readonly DeliveryLifecycleState[]>> = {
  RECEIVED: ["ENQUEUED"],
  ENQUEUED: ["PROCESSING", "DEAD_LETTERED"],
  PROCESSING: ["RETRY_PENDING", "SUCCEEDED", "DEAD_LETTERED"],
  RETRY_PENDING: ["PROCESSING", "DEAD_LETTERED"],
  SUCCEEDED: [],
  DEAD_LETTERED: [],
};

export interface DurableDeliveryState {
  deliveryId: string;
  repository: string;
  projectId: string;
  eventName: string;
  messageVersion: 1;
  state: DeliveryLifecycleState;
  attemptCount: number;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  deadLetteredAt: string | null;
  lastErrorCode: string | null;
}

export function isTerminalDeliveryState(state: DeliveryLifecycleState): boolean {
  return state === "SUCCEEDED" || state === "DEAD_LETTERED";
}

export function assertDeliveryTransition(
  from: DeliveryLifecycleState,
  to: DeliveryLifecycleState,
): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid webhook delivery lifecycle transition: ${from} -> ${to}`);
  }
}

export function nextDeliveryState(
  current: DurableDeliveryState,
  nextState: DeliveryLifecycleState,
  changedAt: string,
  options: { errorCode?: string | null } = {},
): DurableDeliveryState {
  assertDeliveryTransition(current.state, nextState);
  if (Number.isNaN(Date.parse(changedAt))) throw new Error("changedAt must be a valid timestamp");

  const enteringProcessing = nextState === "PROCESSING";
  const enteringSuccess = nextState === "SUCCEEDED";
  const enteringDeadLetter = nextState === "DEAD_LETTERED";
  const errorCode = options.errorCode ?? null;

  if ((nextState === "RETRY_PENDING" || enteringDeadLetter) && !errorCode) {
    throw new Error(`${nextState} requires a stable non-secret error code`);
  }
  if (enteringSuccess && errorCode) {
    throw new Error("SUCCEEDED cannot carry an error code");
  }

  return {
    ...current,
    state: nextState,
    attemptCount: current.attemptCount + (enteringProcessing ? 1 : 0),
    updatedAt: changedAt,
    completedAt: enteringSuccess ? changedAt : current.completedAt,
    deadLetteredAt: enteringDeadLetter ? changedAt : current.deadLetteredAt,
    lastErrorCode: errorCode ?? (enteringSuccess ? null : current.lastErrorCode),
  };
}
