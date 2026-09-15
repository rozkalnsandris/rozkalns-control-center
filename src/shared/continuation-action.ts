import type { ContinuationCampaignRecoveryEvidence } from "../integrations/cloudflare/d1-continuation-campaign-reader.js";
import { coordinateAuthoritativeContinuation } from "./continuation-coordinator.js";
import { readContinuationGithubSnapshot, type ContinuationGithubReadProvider } from "./continuation-github-snapshot.js";
import { planDeterministicContinuation, type ContinuationPlanResult } from "./continuation-plan.js";
import { disabledAction, enabledAction } from "./decision-action-model.js";
import type { DecisionActionState } from "./control-model.js";

export type ContinuationAction = "CONTINUE" | "PAUSE";
export type FoundCampaign = Extract<ContinuationCampaignRecoveryEvidence, { kind: "FOUND" }>;
export interface ContinuationActionRequest {
  action: ContinuationAction;
  repository: string;
  campaignId: string;
  expectedMainSha: string;
  revision: string;
  requestId: string;
}
export interface ContinuationActionActor { subject: string; email: string | null }
export class ContinuationActionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ContinuationActionError"; }
}
export function continuationFail(code: string): never { throw new ContinuationActionError(code); }

export async function continuationFingerprint(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function continuationActionStates(recovery: FoundCampaign): Record<ContinuationAction, DecisionActionState> {
  const campaign = recovery.campaign;
  const reason = campaign.humanGate ? `Human gate: ${campaign.humanGate}; separate owner decision required`
    : campaign.currentTask && campaign.currentTask.state !== "DONE" ? "Current task incomplete"
    : null;
  return {
    CONTINUE: reason ? disabledAction(reason) : enabledAction(),
    PAUSE: campaign.paused ? disabledAction("Continuation already paused") : enabledAction(),
  };
}

/** Only flags and the existing planner's next-task reservation may change. */
export async function planContinuationAction(action: ContinuationAction, recovery: FoundCampaign, dependencies: {
  provider: ContinuationGithubReadProvider;
  now: () => string;
}): Promise<{ campaign: FoundCampaign["campaign"]; plan: ContinuationPlanResult }> {
  const campaign = recovery.campaign;
  const resumed = { ...campaign, continueEnabled: true, paused: false };
  const observedAt = dependencies.now();
  // Evaluate human/current-task gates before reads; never turn a gate into an override.
  if (action === "CONTINUE") {
    const gate = planDeterministicContinuation(resumed, { schemaVersion: 1, repository: campaign.repository, mainSha: campaign.expectedMainSha, observedAt, candidates: [] }, observedAt);
    if (gate.kind === "HUMAN_GATE" || gate.kind === "CURRENT_TASK_INCOMPLETE") continuationFail(gate.kind);
  }
  const evidence = await readContinuationGithubSnapshot(dependencies.provider, campaign.repository, campaign.projectId, recovery.tasks, observedAt);
  if (evidence.mainSha !== campaign.expectedMainSha) continuationFail("EXPECTED_MAIN_SHA_DRIFT");
  const now = dependencies.now();
  if (Date.parse(now) <= Date.parse(campaign.updatedAt)) continuationFail("INVALID_OBSERVATION_TIME");
  const plan = planDeterministicContinuation(action === "CONTINUE" ? resumed : campaign, evidence, now);
  if (action === "PAUSE") return { campaign: { ...campaign, paused: true, nextTaskId: null, updatedAt: now }, plan };
  if (plan.kind !== "READY" && plan.kind !== "NO_ELIGIBLE_TASK") continuationFail(plan.kind);
  if (campaign.nextTaskId !== null && (plan.kind !== "READY" || plan.taskId !== campaign.nextTaskId)) continuationFail("NEXT_TASK_EVIDENCE_DRIFT");
  return { campaign: { ...resumed, nextTaskId: plan.kind === "READY" ? plan.taskId : null, observedAt: now, updatedAt: now }, plan };
}

// Retain the existing coordinator as the authoritative read-only eligibility path.
export async function inspectContinuationAction(recovery: FoundCampaign, dependencies: Parameters<typeof coordinateAuthoritativeContinuation>[3]) {
  return coordinateAuthoritativeContinuation({ ...recovery.campaign, continueEnabled: true, paused: false }, recovery.tasks, recovery.campaign.expectedMainSha, dependencies);
}
