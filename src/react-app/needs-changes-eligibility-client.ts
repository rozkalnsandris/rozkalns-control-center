import type { DecisionReadModel, MockAction, ProjectReadModel } from "../shared/control-model.js";
import { resolveNeedsChangesProjectPolicy } from "../shared/project-policy.js";

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
}

export interface NeedsChangesEligibilityOptions {
  readonly fetcher?: FetchLike;
  readonly signal?: AbortSignal;
}

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

function eligibilityCandidate(item: DecisionReadModel, project: ProjectReadModel): EligibilityCandidate | null {
  if (!project.enabled || item.projectId !== project.id) return null;

  const policy = resolveNeedsChangesProjectPolicy(project.repository);
  if (!policy || policy.id !== project.id) return null;
  if (normalizedRepository(policy.repository) !== normalizedRepository(project.repository)) return null;

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

export function applyAuthoritativeNeedsChangesEligibility(
  item: DecisionReadModel,
  eligible: boolean,
): DecisionReadModel {
  const suppressed = suppressUnverifiedGitHubWriteActions(item);
  if (!eligible) return suppressed;
  return {
    ...suppressed,
    allowedActions: ["NEEDS_CHANGES", ...suppressed.allowedActions],
  };
}

export async function readAuthoritativeNeedsChangesEligibility(
  item: DecisionReadModel,
  project: ProjectReadModel,
  options: NeedsChangesEligibilityOptions = {},
): Promise<boolean> {
  const candidate = eligibilityCandidate(item, project);
  if (!candidate) return false;

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
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return projectedResultMatches(payload, candidate);
  } catch {
    return false;
  }
}
