export const PHASE5_SOURCE_COMPLETION_CONTRACT =
  "control-phase5-source-completion-reconciliation-v1" as const;

export const PHASE5_SOURCE_COMPLETION_STATUS =
  "SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN" as const;

export const PHASE5_SOURCE_COMPLETED_SLICES = [
  "D1_APPLY_EXECUTOR",
  "VERIFICATION_KEY_PROVISION_EXECUTOR",
  "WORKER_ACTIVATION_CANDIDATE",
  "WORKER_ACTIVATION_EXECUTOR",
  "WORKER_POST_ACTIVATION_VERIFIER",
  "RPI5_SIGNER_HANDOFF",
  "SIGNED_OBSERVATION_COMPATIBILITY_VECTORS",
  "SIGNED_OBSERVATION_RECONCILIATION",
  "PRODUCTION_VISIBILITY_HEALTH",
  "PRODUCTION_VISIBILITY_NOTIFICATIONS",
] as const;

export const PHASE5_RETIRED_LIVE_GATES = [
  "D1_APPLY_COMPLETED_NON_REPLAYABLE",
] as const;

export const PHASE5_REMAINING_OWNER_GATES = [
  "CREDENTIAL_ENVIRONMENT_PREREQUISITES_IF_MISSING",
  "VERIFICATION_KEY_PROVISION_IF_FRESH_PREFLIGHT_REQUIRES",
  "WORKER_ACTIVATE_AFTER_PREREQUISITES",
  "RPI5_SIGNER_RUNTIME_AFTER_WORKER_VERIFY",
] as const;

export const PHASE5_READONLY_CHECKPOINTS = [
  "FRESH_EXACT_MAIN_PRODUCTION_PREFLIGHT_BEFORE_FIRST_LIVE_MUTATION",
  "FRESH_D1_STATE_MUST_MATCH_COMPLETED_APPLY_OR_STOP",
  "GET_ONLY_VERIFY_AFTER_VERIFICATION_KEY_PROVISION_IF_RUN",
  "GET_ONLY_VERIFY_UPLOADED_WORKER_VERSION_BEFORE_DEPLOY",
  "GET_ONLY_POST_ACTIVATION_WORKER_VERIFY",
  "READONLY_SIGNED_OBSERVATION_RECONCILIATION_AFTER_RPI5_RUNTIME",
] as const;

export const PHASE5_SOURCE_COMPLETION_INVARIANTS = {
  sourceMergeGrantsLiveAuthority: false,
  readonlyPreflightGrantsMutationAuthority: false,
  crossClassCascade: false,
  historicalAuthorizationReplay: false,
  completedD1ApplyReplay: false,
  protectedValueInPublicEvidence: false,
  automaticRetryRollbackCleanupOrAlternateMutation: false,
  controlOwnsRpi5SignerRuntime: false,
  observationEvidenceGrantsMutationAuthority: false,
} as const;

export type Phase5SourceCompletedSlice = (typeof PHASE5_SOURCE_COMPLETED_SLICES)[number];
export type Phase5RetiredLiveGate = (typeof PHASE5_RETIRED_LIVE_GATES)[number];
export type Phase5RemainingOwnerGate = (typeof PHASE5_REMAINING_OWNER_GATES)[number];
export type Phase5ReadonlyCheckpoint = (typeof PHASE5_READONLY_CHECKPOINTS)[number];

export interface Phase5SourceCompletionReconciliation {
  readonly contract: typeof PHASE5_SOURCE_COMPLETION_CONTRACT;
  readonly status: typeof PHASE5_SOURCE_COMPLETION_STATUS;
  readonly sourceComplete: true;
  readonly liveStateProven: false;
  readonly completedSlices: readonly Phase5SourceCompletedSlice[];
  readonly retiredLiveGates: readonly Phase5RetiredLiveGate[];
  readonly remainingOwnerGates: readonly Phase5RemainingOwnerGate[];
  readonly readonlyCheckpoints: readonly Phase5ReadonlyCheckpoint[];
  readonly firstLiveGateSelection: "REQUIRES_FRESH_READONLY_BASELINE_AND_ENVIRONMENT_EVIDENCE";
  readonly nextSourceLane: null;
  readonly stopAtFirstGenuineLiveOrExternalGate: true;
  readonly invariants: typeof PHASE5_SOURCE_COMPLETION_INVARIANTS;
}

export function getPhase5SourceCompletionReconciliation(): Phase5SourceCompletionReconciliation {
  return {
    contract: PHASE5_SOURCE_COMPLETION_CONTRACT,
    status: PHASE5_SOURCE_COMPLETION_STATUS,
    sourceComplete: true,
    liveStateProven: false,
    completedSlices: [...PHASE5_SOURCE_COMPLETED_SLICES],
    retiredLiveGates: [...PHASE5_RETIRED_LIVE_GATES],
    remainingOwnerGates: [...PHASE5_REMAINING_OWNER_GATES],
    readonlyCheckpoints: [...PHASE5_READONLY_CHECKPOINTS],
    firstLiveGateSelection: "REQUIRES_FRESH_READONLY_BASELINE_AND_ENVIRONMENT_EVIDENCE",
    nextSourceLane: null,
    stopAtFirstGenuineLiveOrExternalGate: true,
    invariants: PHASE5_SOURCE_COMPLETION_INVARIANTS,
  };
}
