import type { LaterDeferralEvidence } from "./later-decision.js";

export const LATER_ACTOR_MAX_BYTES = 512;

export interface LaterDecisionActor {
  readonly subject: string;
  readonly email: string | null;
}

export interface LaterDeferralClaimInput {
  readonly actor: LaterDecisionActor;
  readonly evidence: LaterDeferralEvidence;
}

export interface PersistedLaterDeferral extends LaterDeferralEvidence {
  readonly actor: LaterDecisionActor;
}

export type LaterDeferralClaimResult =
  | { readonly kind: "CLAIMED" }
  | { readonly kind: "REPLAY" }
  | { readonly kind: "CONFLICT" };

export interface LaterDeferralReplaceInput {
  readonly expectedStateFingerprint: string;
  readonly claim: LaterDeferralClaimInput;
}

export type LaterDeferralReplaceResult =
  | { readonly kind: "REPLACED" }
  | { readonly kind: "REPLAY" }
  | { readonly kind: "CONFLICT" };

/**
 * Durable source contract for one active Later deferral per normalized decision.
 *
 * Persistence is evidence only. Implementations do not authenticate actors, decide
 * whether LATER is currently allowed, send notifications or authorize any other
 * action. A future authenticated runtime must create the evidence from fresh
 * normalized decision state before calling this store.
 */
export interface LaterDeferralStore {
  claim(input: LaterDeferralClaimInput): Promise<LaterDeferralClaimResult>;
  read(decisionId: string): Promise<PersistedLaterDeferral | null>;
  replace(input: LaterDeferralReplaceInput): Promise<LaterDeferralReplaceResult>;
}
