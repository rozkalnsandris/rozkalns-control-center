import type { DecisionReadModel, MockAction, ProjectReadModel } from "../shared/control-model.js";
import { resolveManagedProjectPolicy } from "../shared/project-policy.js";

const GITHUB_WRITE_ACTIONS = new Set<MockAction>(["MERGE", "NEEDS_CHANGES"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface EligibilityCandidate {
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly mainSha: string;
  readonly projectId: string;
  readonly canMerge: boolean;
  readonly canRequestChanges: boolean;
}

export interface AuthoritativeGitHubWriteEligibility {
  readonly merge: boolean;
  readonly needsChanges: boolean;
}

export interface NeedsChangesEligibilityOptions {
  readonly fetcher?: FetchLike;
  readonly signal?: AbortSignal;
}

const noGitHubWriteEligibility: AuthoritativeGitHubWriteEligibility = {
  merge: false,
  needsChanges: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isExactSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function normalizedRepository(value: string): string {
  return value.toLowerCase();
}

function hasLiveDashboardActionSignal(item: DecisionReadModel): boolean {
  return item.allowedActions.some((action) => action !== "OPEN_PR");
}

function eligibilityCandidate(item: DecisionReadModel, project: ProjectReadModel): EligibilityCandidate | null {
  if (!hasLiveDashboardActionSignal(item)) return null;
  if (!project.enabled || item.projectId !== project.id) return null;

  const policy = resolveManagedProjectPolicy(project.repository);
  if (!policy || policy.id !== project.id) return null;
  if (normalizedRepository(policy.repository) !== normalizedRepository(project.repository)) return null;
  if (!policy.canMerge && !policy.canRequestChanges) return null;

  if (!isPositiveInteger(item.issueNumber) || !isPositiveInteger(item.prNumber)) return null;
  if (!isExactSha(item.expectedHeadSha) || !isExactSha(item.currentHeadSha) || !isExactSha(item.mainSha)) return null;
  if (item.expectedHeadSha !== item.currentHeadSha) return null;

  return {
    repository: policy.repository,
    issueNumber: item.issueNumber,
    pullNumber: item.prNumber,
    headSha: item.currentHeadSha,
    mainSha: item.mainSha,
    projectId: item.projectId,
    canMerge: policy.canMerge,
    canRequestChanges: policy.canRequestChanges,
  };
}

function projectedResultMatches(
  payload: unknown,
  candidate: EligibilityCandidate,
): boolean {
  if (!isRecord(payload) || payload.kind !== "PROJECTED") return false;
  if (typeof payload.repository !== "string" || normalizedRepository(payload.repository) !== normalizedRepository(candidate.repository)) return false;
  if (payload.issueNumber !== candidate.issueNumber || payload.pullNumber !== candidate.pullNumber) return false;

  if (!isRecord(payload.policy) || payload.policy.coverage !== "COMPLETE") return false;
  if (!Array.isArray(payload.policy.blockedReasons) || payload.policy.blockedReasons.length !== 0) return false;

  const decision = payload.decision;
  if (!isRecord(decision)) return false;
  if (decision.projectId !== candidate.projectId) return false;
  if (decision.issueNumber !== candidate.issueNumber || decision.prNumber !== candidate.pullNumber) return false;
  if (decision.workflowState !== "MERGE_READY" || decision.ci !== "PASS") return false;
  if (decision.review !== "PASS" && decision.review !== "NOT_REQUIRED") return false;
  if (decision.expectedHeadSha !== candidate.headSha || decision.currentHeadSha !== candidate.headSha) return false;
  if (decision.mainSha !== candidate.mainSha) return false;
  return true;
}

export function suppressUnverifiedGitHubWriteActions(item: DecisionReadModel): DecisionReadModel {
  return {
    ...item,
    allowedActions: item.allowedActions.filter((action) => !GITHUB_WRITE_ACTIONS.has(action)),
  };
}

export function applyAuthoritativeGitHubWriteEligibility(
  item: DecisionReadModel,
  eligibility: AuthoritativeGitHubWriteEligibility,
): DecisionReadModel {
  const suppressed = suppressUnverifiedGitHubWriteActions(item);
  if (!hasLiveDashboardActionSignal(item)) return suppressed;

  const verifiedActions: MockAction[] = [];
  if (eligibility.merge) verifiedActions.push("MERGE");
  if (eligibility.needsChanges) verifiedActions.push("NEEDS_CHANGES");
  if (verifiedActions.length === 0) return suppressed;

  return {
    ...suppressed,
    allowedActions: [...verifiedActions, ...suppressed.allowedActions],
  };
}

export function applyAuthoritativeNeedsChangesEligibility(
  item: DecisionReadModel,
  eligible: boolean,
): DecisionReadModel {
  return applyAuthoritativeGitHubWriteEligibility(item, {
    merge: false,
    needsChanges: eligible,
  });
}

export async function readAuthoritativeGitHubWriteEligibility(
  item: DecisionReadModel,
  project: ProjectReadModel,
  options: NeedsChangesEligibilityOptions = {},
): Promise<AuthoritativeGitHubWriteEligibility> {
  const candidate = eligibilityCandidate(item, project);
  if (!candidate) return noGitHubWriteEligibility;

  const params = new URLSearchParams({
    repository: candidate.repository,
    issue: String(candidate.issueNumber),
    pull: String(candidate.pullNumber),
  });
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);

  try {
    const response = await fetcher(`/api/github/reconcile?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
    if (!response.ok) return noGitHubWriteEligibility;
    const payload: unknown = await response.json();
    if (!projectedResultMatches(payload, candidate)) return noGitHubWriteEligibility;
    return {
      merge: candidate.canMerge,
      needsChanges: candidate.canRequestChanges,
    };
  } catch {
    return noGitHubWriteEligibility;
  }
}

export async function readAuthoritativeNeedsChangesEligibility(
  item: DecisionReadModel,
  project: ProjectReadModel,
  options: NeedsChangesEligibilityOptions = {},
): Promise<boolean> {
  const policy = resolveManagedProjectPolicy(project.repository);
  if (!policy || policy.canRequestChanges !== true) return false;
  const eligibility = await readAuthoritativeGitHubWriteEligibility(item, project, options);
  return eligibility.needsChanges;
}
