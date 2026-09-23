import type { DecisionActionState, DecisionReadModel, ProjectReadModel } from "./control-model.js";
import { resolveManagedProjectPolicy, resolveOwnerWorkflowTarget } from "./project-policy.js";

export const OWNER_ACTIONS = ["MERGE", "LIVE", "CONTINUE"] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];
export const OWNER_ACTION_LABELS: Readonly<Record<OwnerAction, string>> = {
  MERGE: "Merge",
  LIVE: "Live",
  CONTINUE: "Continue",
};

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const enabled = (): DecisionActionState => ({ state: "enabled", reason: null });
const disabled = (reason: string): DecisionActionState => ({ state: "disabled", reason });
const unavailable = (reason: string): DecisionActionState => ({ state: "unavailable", reason });

export interface OwnerActionPresentationContext {
  readonly live: boolean;
  readonly mutationsLocked: boolean;
  readonly mergeEnabled: boolean;
  readonly blockedReason?: string;
}

export function ownerActionPresentationState(
  action: OwnerAction,
  item: DecisionReadModel,
  project: ProjectReadModel,
  context: OwnerActionPresentationContext,
): DecisionActionState {
  const block = context.blockedReason ?? (!context.live ? "Fresh live state required" : null);
  if (block) return disabled(block);
  if (context.mutationsLocked) return disabled("Action in progress");

  const policy = resolveManagedProjectPolicy(project.repository);
  if (!policy || policy.id !== item.projectId || project.id !== item.projectId || !project.enabled) {
    return unavailable("Action not allowed by project policy");
  }

  if (action === "MERGE") {
    if (!policy.canMerge) return unavailable("Merge not enabled for this project");
    return context.mergeEnabled ? enabled() : disabled("Fresh merge eligibility not verified");
  }

  if (!SHA_PATTERN.test(item.mainSha)) return disabled("Exact main SHA unavailable");
  if (action === "LIVE" && !policy.canLive) return unavailable("Live not enabled for this project");
  if (action === "CONTINUE" && !policy.canContinue) return unavailable("Continue not enabled for this project");
  const mapping = resolveOwnerWorkflowTarget(project.repository, action);
  if (!mapping) return unavailable(`${OWNER_ACTION_LABELS[action]} workflow not configured`);
  return enabled();
}
