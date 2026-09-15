import { DECISION_ACTIONS, type DecisionActionStates, type DecisionActionState, type DecisionReadModel, type ProjectReadModel } from "./control-model.js";
import { resolveManagedProjectPolicy } from "./project-policy.js";
import { classifyDashboardFreshness } from "./dashboard-freshness.js";

export const RETRY_CI_UNAVAILABLE_REASON = "Retry CI unavailable: approved Control capability lacks Actions: write";
export const ACTION_LABELS = { OPEN_PR: "Open PR", MERGE: "Merge", NEEDS_CHANGES: "Needs changes", LATER: "Later", RETRY_CI: "Retry CI", CONTINUE: "Continue", PAUSE: "Pause" } as const;
export const enabledAction = (): DecisionActionState => ({ state: "enabled", reason: null });
export const disabledAction = (reason: string): DecisionActionState => ({ state: "disabled", reason });
export const unavailableAction = (reason: string): DecisionActionState => ({ state: "unavailable", reason });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDecisionActionStates(value: unknown): value is DecisionActionStates {
  if (!record(value) || Object.keys(value).length !== DECISION_ACTIONS.length) return false;
  return DECISION_ACTIONS.every((action) => {
    const entry = value[action];
    if (!record(entry) || Object.keys(entry).sort().join(",") !== "reason,state") return false;
    return entry.state === "enabled" ? entry.reason === null
      : (entry.state === "disabled" || entry.state === "unavailable") && typeof entry.reason === "string" && entry.reason.trim().length > 0 && entry.reason.length <= 240;
  });
}

export function exactPullRequestUrl(item: DecisionReadModel, project: ProjectReadModel): string | null {
  if (!Number.isSafeInteger(item.prNumber) || Number(item.prNumber) <= 0) return null;
  const exact = `https://github.com/${project.repository}/pull/${item.prNumber}`;
  return item.prUrl === exact ? exact : null;
}

export function decisionSnapshotBlock(item: DecisionReadModel, nowMs = Date.now()): string | null {
  const freshness = classifyDashboardFreshness({ generatedAt: item.lastReconciledAt, decisions: [item] }, nowMs);
  if (freshness.state !== "FRESH") return `${freshness.state.toLowerCase()} snapshot`;
  if (Date.parse(item.lastReconciledAt) > nowMs) return "Future snapshot";
  return null;
}

/** Presentation only: Worker mutation handlers independently revalidate authority. */
export function normalizeDecisionActions(item: DecisionReadModel, project: ProjectReadModel, options: {
  live: boolean;
  nowMs?: number;
  blockedReason?: string;
  verifiedGitHub?: { merge: boolean; needsChanges: boolean };
}): DecisionReadModel {
  const policy = resolveManagedProjectPolicy(project.repository);
  const block = options.blockedReason ?? (!options.live ? "Fixture mode: no mutation authority" : decisionSnapshotBlock(item, options.nowMs));
  const unavailable = unavailableAction("Action not allowed by project policy");
  const states: DecisionActionStates = {
    OPEN_PR: exactPullRequestUrl(item, project) ? enabledAction() : unavailableAction("No exact PR link"),
    MERGE: unavailable,
    NEEDS_CHANGES: unavailable,
    LATER: unavailable,
    RETRY_CI: unavailableAction(RETRY_CI_UNAVAILABLE_REASON),
    CONTINUE: item.actionStates?.CONTINUE ?? disabledAction("Continuation eligibility not yet verified"),
    PAUSE: item.actionStates?.PAUSE ?? disabledAction("Continuation eligibility not yet verified"),
  };
  const identityValid = project.enabled && policy?.id === item.projectId && project.id === item.projectId;
  if (identityValid && policy) {
    let githubReason: string | null = null;
    if (item.prNumber === null) githubReason = "No PR";
    else if (item.issueNumber === null) githubReason = "No exact linked issue";
    else if (!/^[0-9a-f]{40}$/.test(item.expectedHeadSha ?? "") || item.expectedHeadSha !== item.currentHeadSha) githubReason = "Head mismatch";
    else if (item.ci !== "PASS") githubReason = "CI not passing";
    else if (item.review !== "PASS" && item.review !== "NOT_REQUIRED") githubReason = "Review pending or changes requested";
    if (policy.canMerge) states.MERGE = !githubReason && options.verifiedGitHub?.merge ? enabledAction() : disabledAction(githubReason ?? "Authoritative head/base/policy verification pending or unavailable");
    if (policy.canRequestChanges) states.NEEDS_CHANGES = !githubReason && options.verifiedGitHub?.needsChanges ? enabledAction() : disabledAction(githubReason ?? "Authoritative head/base/policy verification pending or unavailable");
    if (policy.canLater) states.LATER = item.allowedActions.includes("LATER") ? enabledAction() : disabledAction("Current decision cannot be deferred");
  } else {
    states.CONTINUE = unavailable;
    states.PAUSE = unavailable;
  }
  if (block) for (const action of DECISION_ACTIONS) if (action !== "OPEN_PR") states[action] = disabledAction(block);
  return { ...item, actionStates: states };
}
