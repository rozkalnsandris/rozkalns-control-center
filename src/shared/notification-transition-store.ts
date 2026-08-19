import type { NotificationCandidate } from "./notification-transition.js";

export interface NotificationTransitionClaim {
  candidate: NotificationCandidate;
  claimedAt: string;
}

export type NotificationTransitionClaimResult =
  | { kind: "CLAIMED" }
  | { kind: "DUPLICATE" };

export interface NotificationTransitionStore {
  claim(input: NotificationTransitionClaim): Promise<NotificationTransitionClaimResult>;
}
