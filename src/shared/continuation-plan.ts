import { requireManagedProjectPolicy } from "./project-policy.js";

export type ContinuationTaskState =
  | "DISCOVERED"
  | "READY"
  | "WORKING"
  | "WAITING"
  | "PR_DRAFT"
  | "WAIT_CI"
  | "REVIEW"
  | "NEEDS_ANDRIS"
  | "MERGE_READY"
  | "MERGED"
  | "DEPLOY_DECISION"
  | "PRODUCTION_VERIFY"
  | "DONE"
  | "PAUSED"
  | "BLOCKED"
  | "CI_FAILED"
  | "CANCELLED";

export type ContinuationHumanGate =
  | "MERGE"
  | "DEPLOY"
  | "NEEDS_CHANGES"
  | "PRODUCTION_MUTATION";

export interface ContinuationCurrentTask {
  readonly taskId: string;
  readonly state: ContinuationTaskState;
}

export interface ContinuationCampaignSnapshot {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly continueEnabled: boolean;
  readonly paused: boolean;
  readonly currentTask: ContinuationCurrentTask | null;
  readonly humanGate: ContinuationHumanGate | null;
}

export interface ContinuationTaskCandidate {
  readonly taskId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueState: "OPEN" | "CLOSED";
  readonly taskState: ContinuationTaskState;
  readonly activePullRequestNumber: number | null;
  readonly priority: number;
}

export interface ContinuationGithubSnapshot {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly mainSha: string;
  readonly observedAt: string;
  readonly candidates: readonly ContinuationTaskCandidate[];
}

export type ContinuationPlanResult =
  | { readonly kind: "PAUSED" }
  | { readonly kind: "CONTINUATION_DISABLED" }
  | { readonly kind: "HUMAN_GATE"; readonly gate: ContinuationHumanGate }
  | {
      readonly kind: "CURRENT_TASK_INCOMPLETE";
      readonly state: ContinuationTaskState;
    }
  | { readonly kind: "NO_ELIGIBLE_TASK" }
  | {
      readonly kind: "READY";
      readonly campaignId: string;
      readonly projectId: string;
      readonly repository: string;
      readonly taskId: string;
      readonly issueNumber: number;
      readonly expectedMainSha: string;
      readonly observedAt: string;
    };

export type ContinuationPlanErrorCode =
  | "INVALID_INPUT"
  | "REPOSITORY_NOT_ALLOWED"
  | "REPOSITORY_EVIDENCE_MISMATCH"
  | "STALE_GITHUB_EVIDENCE"
  | "TOO_MANY_CANDIDATES"
  | "DUPLICATE_CANDIDATE";

export class ContinuationPlanError extends Error {
  readonly code: ContinuationPlanErrorCode;

  constructor(code: ContinuationPlanErrorCode) {
    super("Deterministic continuation planning failed closed");
    this.name = "ContinuationPlanError";
    this.code = code;
  }
}

export const MAX_CONTINUATION_CANDIDATES = 100;
export const MAX_CONTINUATION_EVIDENCE_AGE_MS = 60_000;

const TASK_STATES = new Set<ContinuationTaskState>([
  "DISCOVERED",
  "READY",
  "WORKING",
  "WAITING",
  "PR_DRAFT",
  "WAIT_CI",
  "REVIEW",
  "NEEDS_ANDRIS",
  "MERGE_READY",
  "MERGED",
  "DEPLOY_DECISION",
  "PRODUCTION_VERIFY",
  "DONE",
  "PAUSED",
  "BLOCKED",
  "CI_FAILED",
  "CANCELLED",
]);

const HUMAN_GATES = new Set<ContinuationHumanGate>([
  "MERGE",
  "DEPLOY",
  "NEEDS_CHANGES",
  "PRODUCTION_MUTATION",
]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAIN_SHA_PATTERN = /^[0-9a-f]{40}$/;

function fail(code: ContinuationPlanErrorCode): never {
  throw new ContinuationPlanError(code);
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) fail("INVALID_INPUT");
  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireTaskState(value: unknown): ContinuationTaskState {
  if (typeof value !== "string" || !TASK_STATES.has(value as ContinuationTaskState)) {
    fail("INVALID_INPUT");
  }
  return value as ContinuationTaskState;
}

function validateCandidate(
  candidate: ContinuationTaskCandidate,
  repository: string,
  projectId: string,
): void {
  if (!candidate || typeof candidate !== "object") fail("INVALID_INPUT");
  requireIdentifier(candidate.taskId);
  if (candidate.repository !== repository || candidate.projectId !== projectId) {
    fail("REPOSITORY_EVIDENCE_MISMATCH");
  }
  if (!Number.isSafeInteger(candidate.issueNumber) || candidate.issueNumber <= 0) {
    fail("INVALID_INPUT");
  }
  if (candidate.issueState !== "OPEN" && candidate.issueState !== "CLOSED") {
    fail("INVALID_INPUT");
  }
  requireTaskState(candidate.taskState);
  if (
    candidate.activePullRequestNumber !== null &&
    (!Number.isSafeInteger(candidate.activePullRequestNumber) ||
      candidate.activePullRequestNumber <= 0)
  ) {
    fail("INVALID_INPUT");
  }
  if (
    !Number.isSafeInteger(candidate.priority) ||
    candidate.priority < 0 ||
    candidate.priority > 1_000_000
  ) {
    fail("INVALID_INPUT");
  }
}

/**
 * Select one next eligible task from bounded, fresh GitHub observation.
 *
 * This detached function only returns planning evidence. READY is not
 * authorization to merge, deploy, send a notification, mutate durable state,
 * schedule background work, or bypass an explicit owner gate.
 */
export function planDeterministicContinuation(
  campaign: ContinuationCampaignSnapshot,
  evidence: ContinuationGithubSnapshot,
  observedAtInput: string,
): ContinuationPlanResult {
  if (!campaign || typeof campaign !== "object" || campaign.schemaVersion !== 1) {
    fail("INVALID_INPUT");
  }
  const campaignId = requireIdentifier(campaign.campaignId);
  const projectId = requireIdentifier(campaign.projectId);
  if (typeof campaign.continueEnabled !== "boolean" || typeof campaign.paused !== "boolean") {
    fail("INVALID_INPUT");
  }
  if (campaign.humanGate !== null && !HUMAN_GATES.has(campaign.humanGate)) {
    fail("INVALID_INPUT");
  }
  if (campaign.currentTask !== null) {
    if (!campaign.currentTask || typeof campaign.currentTask !== "object") fail("INVALID_INPUT");
    requireIdentifier(campaign.currentTask.taskId);
    requireTaskState(campaign.currentTask.state);
  }

  let policy;
  try {
    policy = requireManagedProjectPolicy(campaign.repository);
  } catch {
    fail("REPOSITORY_NOT_ALLOWED");
  }
  if (campaign.repository !== policy.repository || projectId !== policy.id) {
    fail("REPOSITORY_EVIDENCE_MISMATCH");
  }

  if (!evidence || typeof evidence !== "object" || evidence.schemaVersion !== 1) {
    fail("INVALID_INPUT");
  }
  if (evidence.repository !== policy.repository) fail("REPOSITORY_EVIDENCE_MISMATCH");
  if (typeof evidence.mainSha !== "string" || !MAIN_SHA_PATTERN.test(evidence.mainSha)) {
    fail("INVALID_INPUT");
  }

  const observedAt = requireTimestamp(observedAtInput);
  const githubObservedAt = requireTimestamp(evidence.observedAt);
  const age = Date.parse(observedAt) - Date.parse(githubObservedAt);
  if (age < 0 || age > MAX_CONTINUATION_EVIDENCE_AGE_MS) fail("STALE_GITHUB_EVIDENCE");

  if (!Array.isArray(evidence.candidates)) fail("INVALID_INPUT");
  if (evidence.candidates.length > MAX_CONTINUATION_CANDIDATES) {
    fail("TOO_MANY_CANDIDATES");
  }

  const taskIds = new Set<string>();
  const issueNumbers = new Set<number>();
  for (const candidate of evidence.candidates) {
    validateCandidate(candidate, policy.repository, projectId);
    if (taskIds.has(candidate.taskId) || issueNumbers.has(candidate.issueNumber)) {
      fail("DUPLICATE_CANDIDATE");
    }
    taskIds.add(candidate.taskId);
    issueNumbers.add(candidate.issueNumber);
  }

  if (campaign.humanGate !== null) return { kind: "HUMAN_GATE", gate: campaign.humanGate };
  if (campaign.paused) return { kind: "PAUSED" };
  if (!campaign.continueEnabled) return { kind: "CONTINUATION_DISABLED" };
  if (campaign.currentTask !== null && campaign.currentTask.state !== "DONE") {
    return { kind: "CURRENT_TASK_INCOMPLETE", state: campaign.currentTask.state };
  }

  const eligible = evidence.candidates
    .filter(
      (candidate) =>
        candidate.issueState === "OPEN" &&
        (candidate.taskState === "DISCOVERED" || candidate.taskState === "READY") &&
        candidate.activePullRequestNumber === null &&
        candidate.taskId !== campaign.currentTask?.taskId,
    )
    .sort((left, right) => left.priority - right.priority || left.issueNumber - right.issueNumber);

  const next = eligible[0];
  if (!next) return { kind: "NO_ELIGIBLE_TASK" };

  return {
    kind: "READY",
    campaignId,
    projectId,
    repository: policy.repository,
    taskId: next.taskId,
    issueNumber: next.issueNumber,
    expectedMainSha: evidence.mainSha,
    observedAt: githubObservedAt,
  };
}
