import type {
  CiState,
  DecisionReadModel,
  DeployImpact,
  ReviewState as UiReviewState,
  WorkflowState,
} from "./control-model.js";
import {
  selectLatestEffectiveCheckRuns,
  selectLatestEffectiveCommitStatuses,
  selectLatestEffectiveWorkflowRuns,
} from "./github-evidence-selection.js";
import { requireManagedProjectPolicy } from "./project-policy.js";
import type {
  ChangeRequestReadSnapshot,
  CheckRunRead,
  CommitStatusEvidenceCoverage,
  CommitStatusRead,
  IssueRead,
  PullRequestMergeStateRead,
  PullRequestReviewRead,
  WorkflowRunRead,
} from "./source-control-read.js";

export interface RequiredCheckPolicy {
  context: string;
  integrationId: number | null;
}

export interface CiRequirementPolicy {
  requiredChecks: readonly RequiredCheckPolicy[];
  requiredWorkflowNames: readonly string[];
}

export interface ReviewRequirementPolicy {
  requiredApprovals: number;
}

export interface DecisionProjectionContext {
  issue: IssueRead;
  ciPolicy?: CiRequirementPolicy;
  reviewPolicy?: ReviewRequirementPolicy;
  deployImpact?: DeployImpact;
}

type EvidenceState = "success" | "failure" | "running" | "waiting";

const passingCheckConclusions = new Set(["success", "neutral", "skipped"]);
const failureConclusions = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

function evaluateCheck(check: CheckRunRead): EvidenceState {
  if (check.status !== "completed") return "running";
  if (check.conclusion && passingCheckConclusions.has(check.conclusion)) return "success";
  if (check.conclusion && failureConclusions.has(check.conclusion)) return "failure";
  return "waiting";
}

function evaluateCommitStatus(status: CommitStatusRead): EvidenceState {
  if (status.state === "success") return "success";
  if (status.state === "failure" || status.state === "error") return "failure";
  return "running";
}

function evaluateWorkflow(run: WorkflowRunRead): EvidenceState {
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") return "success";
  if (run.conclusion && failureConclusions.has(run.conclusion)) return "failure";
  return "waiting";
}

function foldEvidence(states: readonly EvidenceState[]): CiState {
  if (states.includes("failure")) return "FAIL";
  if (states.includes("running")) return "RUNNING";
  if (states.includes("waiting")) return "WAITING";
  return states.length > 0 ? "PASS" : "WAITING";
}

function sameContext(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function evaluateRequiredCheck(
  checkRuns: readonly CheckRunRead[],
  commitStatuses: readonly CommitStatusRead[],
  required: RequiredCheckPolicy,
): EvidenceState[] {
  const contextChecks = checkRuns.filter((item) => sameContext(item.name, required.context));
  const contextStatuses = commitStatuses.filter((item) => sameContext(item.context, required.context));
  const states: EvidenceState[] = [];

  if (required.integrationId !== null) {
    const matchingChecks = contextChecks.filter((item) => item.appId === required.integrationId);
    if (matchingChecks.length === 0) states.push("waiting");
    else states.push(...matchingChecks.map(evaluateCheck));

    for (const status of contextStatuses) {
      const state = evaluateCommitStatus(status);
      states.push(state === "success" ? "waiting" : state);
    }

    return states;
  }

  if (contextChecks.length === 0 && contextStatuses.length === 0) return ["waiting"];
  states.push(...contextChecks.map(evaluateCheck));
  states.push(...contextStatuses.map(evaluateCommitStatus));
  return states;
}

function normalizeCommitStatusCoverage(value: CommitStatusEvidenceCoverage): CommitStatusEvidenceCoverage {
  if (value === "OBSERVED" || value === "NOT_REQUESTED") return value;
  throw new Error("Unsupported commit-status evidence coverage");
}

export function aggregateCiState(
  checkRuns: readonly CheckRunRead[],
  commitStatuses: readonly CommitStatusRead[],
  workflowRuns: readonly WorkflowRunRead[],
  policy?: CiRequirementPolicy,
  commitStatusCoverage: CommitStatusEvidenceCoverage = "OBSERVED",
): CiState {
  if (!policy) return "WAITING";
  const coverage = normalizeCommitStatusCoverage(commitStatusCoverage);

  const effectiveCheckRuns = selectLatestEffectiveCheckRuns(checkRuns);
  const effectiveCommitStatuses = selectLatestEffectiveCommitStatuses(commitStatuses);
  const effectiveWorkflowRuns = selectLatestEffectiveWorkflowRuns(workflowRuns);
  const states: EvidenceState[] = [];

  for (const required of policy.requiredChecks) {
    states.push(...evaluateRequiredCheck(effectiveCheckRuns, effectiveCommitStatuses, required));
    if (coverage === "NOT_REQUESTED") states.push("waiting");
  }

  for (const requiredName of policy.requiredWorkflowNames) {
    const matches = effectiveWorkflowRuns.filter((item) => item.name === requiredName);
    if (matches.length === 0) {
      states.push("waiting");
      continue;
    }
    states.push(...matches.map(evaluateWorkflow));
  }

  return foldEvidence(states);
}

export function aggregateReviewState(
  reviews: readonly PullRequestReviewRead[],
  policy?: ReviewRequirementPolicy,
): UiReviewState {
  const latestByActor = new Map<string, PullRequestReviewRead>();
  for (const review of reviews) latestByActor.set(review.actor.toLowerCase(), review);

  const effective = [...latestByActor.values()];
  if (effective.some((review) => review.state === "CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (!policy) return "PENDING";
  if (!Number.isInteger(policy.requiredApprovals) || policy.requiredApprovals < 0) return "PENDING";
  if (policy.requiredApprovals === 0) return "NOT_REQUIRED";

  const approvals = effective.filter((review) => review.state === "APPROVED").length;
  return approvals >= policy.requiredApprovals ? "PASS" : "PENDING";
}

function assertExactHeadEvidence(snapshot: ChangeRequestReadSnapshot): void {
  const expected = snapshot.pullRequest.headSha;
  normalizeCommitStatusCoverage(snapshot.commitStatusCoverage);
  if (snapshot.commitStatusCoverage === "NOT_REQUESTED" && snapshot.commitStatuses.length > 0) {
    throw new Error("Commit-status evidence cannot be present when its source was not requested");
  }
  if (snapshot.mergeState.pullNumber !== snapshot.pullRequest.number) {
    throw new Error("Cannot project merge-state evidence from a different pull request");
  }
  if (snapshot.mergeState.headSha !== expected) {
    throw new Error("Cannot project merge-state evidence from a different pull-request head SHA");
  }
  if (snapshot.mergeState.draft !== snapshot.pullRequest.draft) {
    throw new Error("Cannot project merge-state evidence with a conflicting draft state");
  }
  if (snapshot.checkRuns.some((item) => item.headSha !== expected)) {
    throw new Error("Cannot project check evidence from a different pull-request head SHA");
  }
  if (snapshot.commitStatuses.some((item) => item.headSha !== expected)) {
    throw new Error("Cannot project commit-status evidence from a different pull-request head SHA");
  }
  if (snapshot.workflowRuns.some((item) => item.headSha !== expected)) {
    throw new Error("Cannot project workflow evidence from a different pull-request head SHA");
  }
}

function isReadyAccordingToGitHub(mergeState: PullRequestMergeStateRead): boolean {
  return !mergeState.draft && mergeState.mergeable === "MERGEABLE" && mergeState.mergeStateStatus === "CLEAN";
}

function deriveWorkflowState(
  snapshot: ChangeRequestReadSnapshot,
  ci: CiState,
  review: UiReviewState,
): WorkflowState {
  if (snapshot.pullRequest.state === "closed") return "DONE";
  if (ci === "FAIL") return "CI_FAILED";
  if (snapshot.pullRequest.draft || ci === "RUNNING" || ci === "WAITING") return "WAITING";
  if (review === "CHANGES_REQUESTED") return "NEEDS_ANDRIS";
  if (ci === "PASS" && review === "PASS" && isReadyAccordingToGitHub(snapshot.mergeState)) return "MERGE_READY";
  return "WAITING";
}

function reasonFor(
  state: WorkflowState,
  ci: CiState,
  review: UiReviewState,
  mergeState: PullRequestMergeStateRead,
): string {
  if (state === "DONE") return "The pull request is closed; no live action is available from this read-only projection.";
  if (state === "CI_FAILED") return "Required CI evidence failed. The decision must wait for authoritative evidence to change.";
  if (review === "CHANGES_REQUESTED") return "The latest effective review state includes changes requested; human attention is required.";
  if (state === "MERGE_READY") {
    return "Required CI/review evidence is satisfied and GitHub reports this exact PR head as MERGEABLE/CLEAN; Phase 2 remains read-only.";
  }
  if (ci === "RUNNING") return "Required CI evidence is still running; Control must wait for a fresh authoritative reconciliation.";
  if (ci === "WAITING") return "Required CI evidence is missing, ambiguous, or not successful; Control must fail closed and wait.";
  if (ci === "PASS" && review === "PASS") {
    return `CI/review evidence is satisfied, but GitHub merge state is ${mergeState.mergeable}/${mergeState.mergeStateStatus}; Control must remain non-ready.`;
  }
  return "Read-only evidence is incomplete; no mutation is allowed.";
}

export function projectAuthoritativeSnapshotToDecision(
  snapshot: ChangeRequestReadSnapshot,
  context: DecisionProjectionContext,
): DecisionReadModel {
  if (!snapshot.authoritativeRead) throw new Error("Only authoritative source-control snapshots may be projected");
  assertExactHeadEvidence(snapshot);

  const project = requireManagedProjectPolicy(snapshot.repository);
  const ci = aggregateCiState(
    snapshot.checkRuns,
    snapshot.commitStatuses,
    snapshot.workflowRuns,
    context.ciPolicy,
    snapshot.commitStatusCoverage,
  );
  const review = aggregateReviewState(snapshot.reviews, context.reviewPolicy);
  const workflowState = deriveWorkflowState(snapshot, ci, review);

  return {
    id: `github:${project.id}:pr:${snapshot.pullRequest.number}`,
    projectId: project.id,
    workflowState,
    issueNumber: context.issue.number,
    issueTitle: context.issue.title,
    prNumber: snapshot.pullRequest.number,
    prTitle: snapshot.pullRequest.title,
    ci,
    review,
    deployImpact: context.deployImpact ?? "UNKNOWN",
    changedFiles: snapshot.pullRequest.changedFiles,
    expectedHeadSha: snapshot.pullRequest.headSha,
    currentHeadSha: snapshot.pullRequest.headSha,
    mainSha: snapshot.mainSha,
    reason: reasonFor(workflowState, ci, review, snapshot.mergeState),
    lastReconciledAt: snapshot.observedAt,
    allowedActions: ["OPEN_PR"],
  };
}
