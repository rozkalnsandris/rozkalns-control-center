import type {
  CiState,
  ControlDashboardData,
  DecisionReadModel,
  ProjectReadModel,
  ReviewState,
  WorkflowState,
} from "./control-model.js";
import {
  selectLatestEffectiveCheckRuns,
  selectLatestEffectiveWorkflowRuns,
} from "./github-evidence-selection.js";
import { aggregateReviewState, isReviewRequirementSatisfied } from "./github-projection.js";
import { managedProjectPolicies, type ManagedProjectPolicy } from "./project-policy.js";
import type {
  CheckRunRead,
  PullRequestMergeStateRead,
  PullRequestRead,
  SourceControlReadProvider,
  WorkflowRunRead,
} from "./source-control-read.js";

export interface LiveDashboardRepositoryReadContext {
  readonly provider: SourceControlReadProvider;
}

export interface LiveDashboardReadContextFactory {
  createRepositoryReadContext(repository: string, observedAt: string): LiveDashboardRepositoryReadContext;
}

type ObservedEvidenceState = "success" | "failure" | "running" | "waiting";

const passingConclusions = new Set(["success", "neutral", "skipped"]);
const failureConclusions = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

function checkState(check: CheckRunRead): ObservedEvidenceState {
  if (check.status !== "completed") return "running";
  if (check.conclusion && passingConclusions.has(check.conclusion)) return "success";
  if (check.conclusion && failureConclusions.has(check.conclusion)) return "failure";
  return "waiting";
}

function workflowState(run: WorkflowRunRead): ObservedEvidenceState {
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") return "success";
  if (run.conclusion && failureConclusions.has(run.conclusion)) return "failure";
  return "waiting";
}

export function aggregateObservedCiState(
  checkRuns: readonly CheckRunRead[],
  workflowRuns: readonly WorkflowRunRead[],
): CiState {
  const states: ObservedEvidenceState[] = [
    ...selectLatestEffectiveCheckRuns(checkRuns).map(checkState),
    ...selectLatestEffectiveWorkflowRuns(workflowRuns).map(workflowState),
  ];

  if (states.includes("failure")) return "FAIL";
  if (states.includes("running")) return "RUNNING";
  if (states.includes("waiting")) return "WAITING";
  return states.length > 0 ? "PASS" : "WAITING";
}

function assertExactHeadEvidence(
  pull: PullRequestRead,
  mergeState: PullRequestMergeStateRead,
  checks: readonly CheckRunRead[],
  workflows: readonly WorkflowRunRead[],
): void {
  if (mergeState.pullNumber !== pull.number || mergeState.headSha !== pull.headSha || mergeState.draft !== pull.draft) {
    throw new Error("Live dashboard merge-state evidence does not match the exact pull-request head");
  }
  if (checks.some((check) => check.headSha !== pull.headSha)) {
    throw new Error("Live dashboard check evidence does not match the exact pull-request head");
  }
  if (workflows.some((run) => run.headSha !== pull.headSha)) {
    throw new Error("Live dashboard workflow evidence does not match the exact pull-request head");
  }
}

function observedWorkflowState(ci: CiState, review: ReviewState): WorkflowState {
  if (ci === "FAIL") return "CI_FAILED";
  if (review === "CHANGES_REQUESTED") return "NEEDS_ANDRIS";
  return "WAITING";
}

function allowedActionsForLiveDecision(
  policy: ManagedProjectPolicy,
  decision: Pick<
    DecisionReadModel,
    "workflowState" | "ci" | "review" | "issueNumber" | "prNumber"
  >,
): DecisionReadModel["allowedActions"] {
  const actions: DecisionReadModel["allowedActions"] = [];
  const gitHubWriteReady =
    decision.issueNumber !== null &&
    decision.prNumber !== null &&
    decision.workflowState === "MERGE_READY" &&
    decision.ci === "PASS" &&
    isReviewRequirementSatisfied(decision.review);

  if (gitHubWriteReady && policy.canMerge) actions.push("MERGE");
  if (gitHubWriteReady && policy.canRequestChanges) actions.push("NEEDS_CHANGES");
  if (policy.canLater) actions.push("LATER");
  actions.push("OPEN_PR");
  return actions;
}

function observedReason(
  pull: PullRequestRead,
  ci: CiState,
  review: ReviewState,
  mergeState: PullRequestMergeStateRead,
): string {
  if (ci === "FAIL") {
    return "An observed exact-head GitHub check or workflow reports failure. GitHub write actions remain unavailable from this lightweight observation.";
  }
  if (review === "CHANGES_REQUESTED") {
    return "The latest effective GitHub review state includes changes requested. Human attention is required; GitHub write actions remain unavailable from this lightweight observation.";
  }
  if (pull.draft) return "The pull request is still a draft. Control waits for the source workflow to advance.";
  if (ci === "RUNNING") return "Exact-head GitHub checks or workflows are still running. Control waits for fresh evidence.";
  if (ci === "WAITING") return "Exact-head CI evidence is missing or ambiguous. Control fails closed and does not declare merge readiness.";
  return `Observed exact-head CI currently passes and GitHub reports ${mergeState.mergeable}/${mergeState.mergeStateStatus}, but branch-policy coverage is not complete enough to declare merge readiness; GitHub write actions remain fail closed.`;
}

async function readDecision(
  policy: ManagedProjectPolicy,
  provider: SourceControlReadProvider,
  pull: PullRequestRead,
  mainSha: string,
  observedAt: string,
): Promise<DecisionReadModel> {
  const [mergeState, reviews, checkRuns, workflowRuns] = await Promise.all([
    provider.getPullRequestMergeState(policy.repository, pull.number),
    provider.listPullRequestReviews(policy.repository, pull.number),
    provider.listCheckRuns(policy.repository, pull.headSha),
    provider.listWorkflowRuns(policy.repository, pull.headSha),
  ]);

  assertExactHeadEvidence(pull, mergeState, checkRuns, workflowRuns);
  const ci = aggregateObservedCiState(checkRuns, workflowRuns);
  const review = aggregateReviewState(reviews);
  const state = observedWorkflowState(ci, review);
  const issueNumber = null;

  return {
    id: `github:${policy.id}:pr:${pull.number}`,
    projectId: policy.id,
    workflowState: state,
    issueNumber,
    issueTitle: null,
    prNumber: pull.number,
    prTitle: pull.title,
    prUrl: pull.htmlUrl,
    ci,
    review,
    deployImpact: "UNKNOWN",
    changedFiles: pull.changedFiles,
    expectedHeadSha: pull.headSha,
    currentHeadSha: pull.headSha,
    mainSha,
    reason: observedReason(pull, ci, review, mergeState),
    lastReconciledAt: observedAt,
    allowedActions: allowedActionsForLiveDecision(policy, {
      workflowState: state,
      ci,
      review,
      issueNumber,
      prNumber: pull.number,
    }),
  };
}

function projectStatus(decisions: readonly DecisionReadModel[], openPullRequests: number): ProjectReadModel["status"] {
  if (decisions.some((item) => item.workflowState === "NEEDS_ANDRIS" || item.workflowState === "CI_FAILED")) {
    return "ATTENTION";
  }
  if (openPullRequests > 0) return "WAITING";
  return "HEALTHY";
}

async function readProject(
  factory: LiveDashboardReadContextFactory,
  policy: ManagedProjectPolicy,
  observedAt: string,
): Promise<{ project: ProjectReadModel; decisions: DecisionReadModel[] }> {
  const context = factory.createRepositoryReadContext(policy.repository, observedAt);
  const provider = context.provider;
  const repository = await provider.getRepository(policy.repository);
  if (repository.repository.toLowerCase() !== policy.repository.toLowerCase()) {
    throw new Error("Live dashboard provider returned a different repository than requested");
  }

  const [mainSha, openIssues, openPullRequests] = await Promise.all([
    provider.getDefaultBranchHead(policy.repository, repository.defaultBranch),
    provider.listOpenIssues(policy.repository),
    provider.listOpenPullRequests(policy.repository),
  ]);

  const decisions = await Promise.all(
    openPullRequests.map((pull) => readDecision(policy, provider, pull, mainSha, observedAt)),
  );

  return {
    project: {
      id: policy.id,
      displayName: policy.displayName,
      repository: policy.repository,
      enabled: policy.enabled,
      productionAdapter: policy.productionAdapter,
      status: projectStatus(decisions, openPullRequests.length),
      openPullRequests: openPullRequests.length,
      openIssues: openIssues.length,
    },
    decisions,
  };
}

function normalizedObservation(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Live dashboard observation time is invalid");
  const normalized = new Date(milliseconds).toISOString();
  if (normalized !== value) throw new Error("Live dashboard observation time must be canonical ISO-8601 UTC");
  return normalized;
}

export async function readLiveDashboardSnapshot(
  factory: LiveDashboardReadContextFactory,
  observedAtInput: string,
): Promise<ControlDashboardData> {
  const observedAt = normalizedObservation(observedAtInput);
  const policies = managedProjectPolicies.filter((policy) => policy.enabled && policy.githubReadEnabled);
  const results = await Promise.all(policies.map((policy) => readProject(factory, policy, observedAt)));

  return {
    generatedAt: observedAt,
    projects: results.map((result) => result.project),
    decisions: results.flatMap((result) => result.decisions),
  };
}
