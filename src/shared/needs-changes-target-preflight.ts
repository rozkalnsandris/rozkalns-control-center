import { requireManagedProjectPolicy } from "./project-policy.js";
import {
  readAuthoritativePullRequestSnapshot,
  type IssueRead,
  type SourceControlReadProvider,
} from "./source-control-read.js";

export type NeedsChangesTargetPreflightFailureCode =
  | "INVALID_REQUEST"
  | "ISSUE_PULL_IDENTITY_CONFLICT"
  | "ISSUE_NOT_FOUND"
  | "PULL_NOT_READY"
  | "HEAD_MISMATCH"
  | "BASE_MISMATCH"
  | "CI_RUN_NOT_FOUND"
  | "CI_NOT_SUCCESSFUL"
  | "MALFORMED_EVIDENCE";

const failureMessages: Readonly<Record<NeedsChangesTargetPreflightFailureCode, string>> = {
  INVALID_REQUEST: "Needs changes target preflight request failed validation",
  ISSUE_PULL_IDENTITY_CONFLICT: "Needs changes target requires a genuine issue distinct from the pull request",
  ISSUE_NOT_FOUND: "Needs changes target issue was not found in normalized open issues",
  PULL_NOT_READY: "Needs changes target pull request is not open and ready",
  HEAD_MISMATCH: "Needs changes target head does not match the frozen head",
  BASE_MISMATCH: "Needs changes target base does not match the frozen main",
  CI_RUN_NOT_FOUND: "Needs changes target exact CI run was not found",
  CI_NOT_SUCCESSFUL: "Needs changes target exact CI run is not completed successfully",
  MALFORMED_EVIDENCE: "Needs changes target preflight evidence is inconsistent",
};

export class NeedsChangesTargetPreflightError extends Error {
  readonly code: NeedsChangesTargetPreflightFailureCode;

  constructor(code: NeedsChangesTargetPreflightFailureCode) {
    super(failureMessages[code]);
    this.name = "NeedsChangesTargetPreflightError";
    this.code = code;
  }
}

export interface NeedsChangesTargetPreflightRequest {
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly expectedWorkflowRunId: string;
  readonly observedAt: string;
}

export interface NeedsChangesTargetPreflightResult {
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly mainSha: string;
  readonly workflowRunId: string;
  readonly observedAt: string;
}

function fail(code: NeedsChangesTargetPreflightFailureCode): never {
  throw new NeedsChangesTargetPreflightError(code);
}

function canonicalRepository(value: string): string {
  try {
    return requireManagedProjectPolicy(value).repository;
  } catch {
    return fail("INVALID_REQUEST");
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return fail("INVALID_REQUEST");
  return value;
}

function exactSha(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) return fail("INVALID_REQUEST");
  return value;
}

function workflowRunId(value: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return fail("INVALID_REQUEST");
  return value;
}

function observedAt(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    return fail("INVALID_REQUEST");
  }
  return value;
}

function exactOpenIssue(issues: readonly IssueRead[], issueNumber: number): IssueRead {
  const matches = issues.filter((issue) => issue.number === issueNumber);
  if (matches.length === 0) return fail("ISSUE_NOT_FOUND");
  if (matches.length !== 1 || matches[0]?.state !== "open") return fail("MALFORMED_EVIDENCE");
  return matches[0];
}

export async function preflightNeedsChangesTarget(
  provider: SourceControlReadProvider,
  request: NeedsChangesTargetPreflightRequest,
): Promise<NeedsChangesTargetPreflightResult> {
  const repository = canonicalRepository(request.repository);
  const issueNumber = positiveInteger(request.issueNumber);
  const pullNumber = positiveInteger(request.pullNumber);
  const expectedHeadSha = exactSha(request.expectedHeadSha);
  const expectedMainSha = exactSha(request.expectedMainSha);
  const expectedWorkflowRunId = workflowRunId(request.expectedWorkflowRunId);
  const observation = observedAt(request.observedAt);

  if (issueNumber === pullNumber) return fail("ISSUE_PULL_IDENTITY_CONFLICT");

  const [snapshot, openIssues] = await Promise.all([
    readAuthoritativePullRequestSnapshot(provider, repository, pullNumber, observation, {
      commitStatusCoverage: "NOT_REQUESTED",
    }),
    provider.listOpenIssues(repository),
  ]);

  exactOpenIssue(openIssues, issueNumber);

  if (
    snapshot.pullRequest.number !== pullNumber ||
    snapshot.pullRequest.state !== "open" ||
    snapshot.pullRequest.draft ||
    snapshot.mergeState.pullNumber !== pullNumber ||
    snapshot.mergeState.draft ||
    snapshot.mergeState.mergeable !== "MERGEABLE" ||
    snapshot.mergeState.mergeStateStatus !== "CLEAN"
  ) {
    return fail("PULL_NOT_READY");
  }

  if (snapshot.pullRequest.headSha !== expectedHeadSha || snapshot.mergeState.headSha !== expectedHeadSha) {
    return fail("HEAD_MISMATCH");
  }

  if (
    snapshot.mainSha !== expectedMainSha ||
    snapshot.pullRequest.baseSha !== expectedMainSha ||
    snapshot.pullRequest.baseRef !== snapshot.defaultBranch
  ) {
    return fail("BASE_MISMATCH");
  }

  const workflowMatches = snapshot.workflowRuns.filter((run) => run.id === expectedWorkflowRunId);
  if (workflowMatches.length === 0) return fail("CI_RUN_NOT_FOUND");
  if (workflowMatches.length !== 1) return fail("MALFORMED_EVIDENCE");

  const workflow = workflowMatches[0];
  if (
    workflow.headSha !== expectedHeadSha ||
    workflow.status !== "completed" ||
    workflow.conclusion !== "success"
  ) {
    return fail("CI_NOT_SUCCESSFUL");
  }

  return {
    repository,
    issueNumber,
    pullNumber,
    headSha: expectedHeadSha,
    mainSha: expectedMainSha,
    workflowRunId: expectedWorkflowRunId,
    observedAt: observation,
  };
}
