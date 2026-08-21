import {
  MAX_CONTINUATION_CANDIDATES,
  type ContinuationCampaignSnapshot,
  type ContinuationHumanGate,
  type ContinuationTaskCandidate,
  type ContinuationTaskState,
} from "../../shared/continuation-plan.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9:_./ -]{1,128}$/;
const MAIN_SHA_PATTERN = /^[0-9a-f]{40}$/;

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

const READ_CAMPAIGN_SQL = `
SELECT
  campaign_id,
  schema_version,
  project_id,
  repository,
  scope,
  mode,
  continue_enabled,
  paused,
  expected_main_sha,
  current_task_id,
  current_task_state,
  next_task_id,
  human_gate,
  observed_at,
  updated_at
FROM continuation_campaigns
WHERE campaign_id = ?1 AND project_id = ?2 AND repository = ?3
LIMIT 2
`.trim();

const READ_TASKS_SQL = `
SELECT
  campaign_id,
  task_id,
  project_id,
  repository,
  issue_number,
  task_state,
  active_pull_request_number,
  expected_head_sha,
  priority,
  updated_at
FROM continuation_tasks
WHERE campaign_id = ?1 AND project_id = ?2 AND repository = ?3
ORDER BY priority ASC, issue_number ASC
LIMIT ?4
`.trim();

export interface ContinuationCampaignRecoveryIdentity {
  readonly campaignId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly expectedMainSha: string;
}

export interface DurableContinuationCampaignSnapshot extends ContinuationCampaignSnapshot {
  readonly scope: string;
  readonly mode: "CONTINUE_ISSUES";
  readonly expectedMainSha: string;
  readonly nextTaskId: string | null;
  readonly observedAt: string;
  readonly updatedAt: string;
}

export interface DurableContinuationTaskSnapshot
  extends Omit<ContinuationTaskCandidate, "issueState"> {
  readonly expectedHeadSha: string | null;
  readonly updatedAt: string;
}

export type ContinuationCampaignRecoveryEvidence =
  | { readonly kind: "NOT_FOUND" }
  | {
      readonly kind: "FOUND";
      readonly campaign: DurableContinuationCampaignSnapshot;
      readonly tasks: readonly DurableContinuationTaskSnapshot[];
    };

export type D1ContinuationCampaignReaderErrorCode =
  | "INVALID_INPUT"
  | "REPOSITORY_NOT_ALLOWED"
  | "REPOSITORY_EVIDENCE_MISMATCH"
  | "EXPECTED_MAIN_SHA_DRIFT"
  | "D1_QUERY_FAILED"
  | "INVALID_STORED_CAMPAIGN"
  | "INVALID_STORED_TASK"
  | "TOO_MANY_TASKS"
  | "DUPLICATE_TASK"
  | "CAMPAIGN_RACE";

export class D1ContinuationCampaignReaderError extends Error {
  readonly code: D1ContinuationCampaignReaderErrorCode;

  constructor(code: D1ContinuationCampaignReaderErrorCode) {
    super("Durable continuation campaign recovery failed closed");
    this.name = "D1ContinuationCampaignReaderError";
    this.code = code;
  }
}

interface StoredCampaignRow {
  readonly campaign_id: unknown;
  readonly schema_version: unknown;
  readonly project_id: unknown;
  readonly repository: unknown;
  readonly scope: unknown;
  readonly mode: unknown;
  readonly continue_enabled: unknown;
  readonly paused: unknown;
  readonly expected_main_sha: unknown;
  readonly current_task_id: unknown;
  readonly current_task_state: unknown;
  readonly next_task_id: unknown;
  readonly human_gate: unknown;
  readonly observed_at: unknown;
  readonly updated_at: unknown;
}

interface StoredTaskRow {
  readonly campaign_id: unknown;
  readonly task_id: unknown;
  readonly project_id: unknown;
  readonly repository: unknown;
  readonly issue_number: unknown;
  readonly task_state: unknown;
  readonly active_pull_request_number: unknown;
  readonly expected_head_sha: unknown;
  readonly priority: unknown;
  readonly updated_at: unknown;
}

function fail(code: D1ContinuationCampaignReaderErrorCode): never {
  throw new D1ContinuationCampaignReaderError(code);
}

function requireIdentifier(value: unknown, code: D1ContinuationCampaignReaderErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) fail(code);
  return value;
}

function requireSha(value: unknown, code: D1ContinuationCampaignReaderErrorCode): string {
  if (typeof value !== "string" || !MAIN_SHA_PATTERN.test(value)) fail(code);
  return value;
}

function requireCanonicalUtc(
  value: unknown,
  code: D1ContinuationCampaignReaderErrorCode,
): string {
  if (typeof value !== "string") fail(code);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) fail(code);
  return value;
}

function requireTaskState(
  value: unknown,
  code: D1ContinuationCampaignReaderErrorCode,
): ContinuationTaskState {
  if (typeof value !== "string" || !TASK_STATES.has(value as ContinuationTaskState)) fail(code);
  return value as ContinuationTaskState;
}

function normalizeIdentity(
  input: ContinuationCampaignRecoveryIdentity,
): ContinuationCampaignRecoveryIdentity {
  if (!input || typeof input !== "object") fail("INVALID_INPUT");

  const campaignId = requireIdentifier(input.campaignId, "INVALID_INPUT");
  const projectId = requireIdentifier(input.projectId, "INVALID_INPUT");
  const expectedMainSha = requireSha(input.expectedMainSha, "INVALID_INPUT");
  if (typeof input.repository !== "string") fail("INVALID_INPUT");

  let policy;
  try {
    policy = requireManagedProjectPolicy(input.repository);
  } catch {
    fail("REPOSITORY_NOT_ALLOWED");
  }
  if (input.repository !== policy.repository || projectId !== policy.id) {
    fail("REPOSITORY_EVIDENCE_MISMATCH");
  }

  return { campaignId, projectId, repository: policy.repository, expectedMainSha };
}

function successfulRows<Row>(result: D1RunResultLike<Row>): readonly Row[] {
  if (!result || result.success !== true || !Array.isArray(result.results)) {
    fail("D1_QUERY_FAILED");
  }
  return result.results;
}

function normalizeCampaign(
  row: StoredCampaignRow,
  identity: ContinuationCampaignRecoveryIdentity,
): DurableContinuationCampaignSnapshot {
  if (!row || typeof row !== "object" || row.schema_version !== 1) {
    fail("INVALID_STORED_CAMPAIGN");
  }
  if (
    row.campaign_id !== identity.campaignId ||
    row.project_id !== identity.projectId ||
    row.repository !== identity.repository
  ) {
    fail("REPOSITORY_EVIDENCE_MISMATCH");
  }
  if (
    typeof row.scope !== "string" ||
    !SCOPE_PATTERN.test(row.scope) ||
    row.scope.trim().length === 0 ||
    row.mode !== "CONTINUE_ISSUES"
  ) {
    fail("INVALID_STORED_CAMPAIGN");
  }
  if (
    (row.continue_enabled !== 0 && row.continue_enabled !== 1) ||
    (row.paused !== 0 && row.paused !== 1)
  ) {
    fail("INVALID_STORED_CAMPAIGN");
  }

  const expectedMainSha = requireSha(row.expected_main_sha, "INVALID_STORED_CAMPAIGN");
  if (expectedMainSha !== identity.expectedMainSha) fail("EXPECTED_MAIN_SHA_DRIFT");

  const currentTaskId =
    row.current_task_id === null
      ? null
      : requireIdentifier(row.current_task_id, "INVALID_STORED_CAMPAIGN");
  const currentTaskState =
    row.current_task_state === null
      ? null
      : requireTaskState(row.current_task_state, "INVALID_STORED_CAMPAIGN");
  if ((currentTaskId === null) !== (currentTaskState === null)) {
    fail("INVALID_STORED_CAMPAIGN");
  }

  const nextTaskId =
    row.next_task_id === null
      ? null
      : requireIdentifier(row.next_task_id, "INVALID_STORED_CAMPAIGN");
  if (
    row.human_gate !== null &&
    (typeof row.human_gate !== "string" || !HUMAN_GATES.has(row.human_gate as ContinuationHumanGate))
  ) {
    fail("INVALID_STORED_CAMPAIGN");
  }
  const humanGate = row.human_gate as ContinuationHumanGate | null;
  if (
    nextTaskId !== null &&
    (row.continue_enabled !== 1 ||
      row.paused !== 0 ||
      humanGate !== null ||
      (currentTaskState !== null && currentTaskState !== "DONE") ||
      nextTaskId === currentTaskId)
  ) {
    fail("INVALID_STORED_CAMPAIGN");
  }

  const observedAt = requireCanonicalUtc(row.observed_at, "INVALID_STORED_CAMPAIGN");
  const updatedAt = requireCanonicalUtc(row.updated_at, "INVALID_STORED_CAMPAIGN");
  if (Date.parse(updatedAt) < Date.parse(observedAt)) fail("INVALID_STORED_CAMPAIGN");

  return {
    schemaVersion: 1,
    campaignId: identity.campaignId,
    projectId: identity.projectId,
    repository: identity.repository,
    scope: row.scope,
    mode: "CONTINUE_ISSUES",
    continueEnabled: row.continue_enabled === 1,
    paused: row.paused === 1,
    expectedMainSha,
    currentTask:
      currentTaskId === null || currentTaskState === null
        ? null
        : { taskId: currentTaskId, state: currentTaskState },
    nextTaskId,
    humanGate,
    observedAt,
    updatedAt,
  };
}

function normalizeTask(
  row: StoredTaskRow,
  identity: ContinuationCampaignRecoveryIdentity,
): DurableContinuationTaskSnapshot {
  if (!row || typeof row !== "object") fail("INVALID_STORED_TASK");
  if (
    row.campaign_id !== identity.campaignId ||
    row.project_id !== identity.projectId ||
    row.repository !== identity.repository
  ) {
    fail("REPOSITORY_EVIDENCE_MISMATCH");
  }

  const taskId = requireIdentifier(row.task_id, "INVALID_STORED_TASK");
  const issueNumber = row.issue_number;
  if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    fail("INVALID_STORED_TASK");
  }
  const taskState = requireTaskState(row.task_state, "INVALID_STORED_TASK");
  const pullRequest = row.active_pull_request_number;
  if (
    pullRequest !== null &&
    (typeof pullRequest !== "number" || !Number.isSafeInteger(pullRequest) || pullRequest <= 0)
  ) {
    fail("INVALID_STORED_TASK");
  }
  const expectedHeadSha =
    row.expected_head_sha === null
      ? null
      : requireSha(row.expected_head_sha, "INVALID_STORED_TASK");
  if ((pullRequest === null) !== (expectedHeadSha === null)) fail("INVALID_STORED_TASK");

  const priority = row.priority;
  if (
    typeof priority !== "number" ||
    !Number.isSafeInteger(priority) ||
    priority < 0 ||
    priority > 1_000_000
  ) {
    fail("INVALID_STORED_TASK");
  }

  return {
    taskId,
    projectId: identity.projectId,
    repository: identity.repository,
    issueNumber,
    taskState,
    activePullRequestNumber: pullRequest,
    expectedHeadSha,
    priority,
    updatedAt: requireCanonicalUtc(row.updated_at, "INVALID_STORED_TASK"),
  };
}

function validateTaskSet(
  rows: readonly StoredTaskRow[],
  identity: ContinuationCampaignRecoveryIdentity,
): DurableContinuationTaskSnapshot[] {
  if (rows.length > MAX_CONTINUATION_CANDIDATES) fail("TOO_MANY_TASKS");

  const taskIds = new Set<string>();
  const issueNumbers = new Set<number>();
  const pullRequestNumbers = new Set<number>();
  const tasks = rows.map((row) => {
    const task = normalizeTask(row, identity);
    if (
      taskIds.has(task.taskId) ||
      issueNumbers.has(task.issueNumber) ||
      (task.activePullRequestNumber !== null &&
        pullRequestNumbers.has(task.activePullRequestNumber))
    ) {
      fail("DUPLICATE_TASK");
    }
    taskIds.add(task.taskId);
    issueNumbers.add(task.issueNumber);
    if (task.activePullRequestNumber !== null) {
      pullRequestNumbers.add(task.activePullRequestNumber);
    }
    return task;
  });

  for (let index = 1; index < tasks.length; index += 1) {
    const previous = tasks[index - 1];
    const current = tasks[index];
    if (
      previous.priority > current.priority ||
      (previous.priority === current.priority && previous.issueNumber >= current.issueNumber)
    ) {
      fail("INVALID_STORED_TASK");
    }
  }

  return tasks;
}

function validateCampaignTaskLinks(
  campaign: DurableContinuationCampaignSnapshot,
  tasks: readonly DurableContinuationTaskSnapshot[],
): void {
  if (campaign.currentTask !== null) {
    const current = tasks.find((task) => task.taskId === campaign.currentTask?.taskId);
    if (!current || current.taskState !== campaign.currentTask.state) {
      fail("INVALID_STORED_CAMPAIGN");
    }
  }
  if (campaign.nextTaskId !== null) {
    const next = tasks.find((task) => task.taskId === campaign.nextTaskId);
    if (
      !next ||
      (next.taskState !== "DISCOVERED" && next.taskState !== "READY") ||
      next.activePullRequestNumber !== null
    ) {
      fail("INVALID_STORED_CAMPAIGN");
    }
  }
}

function sameCampaign(
  left: DurableContinuationCampaignSnapshot,
  right: DurableContinuationCampaignSnapshot,
): boolean {
  return (
    left.campaignId === right.campaignId &&
    left.projectId === right.projectId &&
    left.repository === right.repository &&
    left.scope === right.scope &&
    left.mode === right.mode &&
    left.continueEnabled === right.continueEnabled &&
    left.paused === right.paused &&
    left.expectedMainSha === right.expectedMainSha &&
    left.currentTask?.taskId === right.currentTask?.taskId &&
    left.currentTask?.state === right.currentTask?.state &&
    left.nextTaskId === right.nextTaskId &&
    left.humanGate === right.humanGate &&
    left.observedAt === right.observedAt &&
    left.updatedAt === right.updatedAt
  );
}

/**
 * Recover one exact campaign through bounded, parameterized reads only.
 *
 * FOUND and nextTaskId are evidence, never authorization to merge, deploy,
 * send, schedule, change durable state, or bypass an explicit owner gate.
 * This detached reader is not connected to a Worker route or production.
 */
export class D1ContinuationCampaignReader {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    if (!database || typeof database.prepare !== "function") fail("INVALID_INPUT");
    this.#database = database;
  }

  async read(
    input: ContinuationCampaignRecoveryIdentity,
  ): Promise<ContinuationCampaignRecoveryEvidence> {
    const identity = normalizeIdentity(input);
    const first = successfulRows(
      await this.#database
        .prepare(READ_CAMPAIGN_SQL)
        .bind(identity.campaignId, identity.projectId, identity.repository)
        .run<StoredCampaignRow>(),
    );
    if (first.length === 0) return { kind: "NOT_FOUND" };
    if (first.length !== 1) fail("INVALID_STORED_CAMPAIGN");

    const campaign = normalizeCampaign(first[0], identity);
    const taskRows = successfulRows(
      await this.#database
        .prepare(READ_TASKS_SQL)
        .bind(
          identity.campaignId,
          identity.projectId,
          identity.repository,
          MAX_CONTINUATION_CANDIDATES + 1,
        )
        .run<StoredTaskRow>(),
    );
    const tasks = validateTaskSet(taskRows, identity);
    validateCampaignTaskLinks(campaign, tasks);

    const final = successfulRows(
      await this.#database
        .prepare(READ_CAMPAIGN_SQL)
        .bind(identity.campaignId, identity.projectId, identity.repository)
        .run<StoredCampaignRow>(),
    );
    if (final.length !== 1) fail("CAMPAIGN_RACE");
    if (!sameCampaign(campaign, normalizeCampaign(final[0], identity))) fail("CAMPAIGN_RACE");

    return { kind: "FOUND", campaign, tasks };
  }
}
