import { MAX_CONTINUATION_CANDIDATES, type ContinuationPlanResult } from "../../shared/continuation-plan.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  D1ContinuationCampaignReader,
  type ContinuationCampaignRecoveryEvidence,
  type DurableContinuationCampaignSnapshot,
  type DurableContinuationTaskSnapshot,
} from "./d1-continuation-campaign-reader.js";
import {
  planContinuationNextTaskTransition,
  type ContinuationNextTaskTransitionProposal,
} from "./continuation-next-task-transition.js";
import type { ContinuationPostMergeTransitionProposal } from "./continuation-post-merge-transition.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

export type ContinuationNextTaskPersistenceResult =
  | { readonly kind: "APPLIED" }
  | { readonly kind: "ALREADY_APPLIED" };

export type D1ContinuationNextTaskStoreErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "D1_WRITE_FAILED"
  | "D1_CHANGE_COUNT_INVALID"
  | "D1_RECOVERY_FAILED"
  | "STALE_DURABLE_STATE"
  | "POSTWRITE_VERIFICATION_FAILED";

export class D1ContinuationNextTaskStoreError extends Error {
  readonly code: D1ContinuationNextTaskStoreErrorCode;

  constructor(code: D1ContinuationNextTaskStoreErrorCode) {
    super("Continuation next-task persistence failed closed");
    this.name = "D1ContinuationNextTaskStoreError";
    this.code = code;
  }
}

interface BuiltStatement {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function fail(code: D1ContinuationNextTaskStoreErrorCode): never {
  throw new D1ContinuationNextTaskStoreError(code);
}

function sameCampaign(
  left: DurableContinuationCampaignSnapshot,
  right: DurableContinuationCampaignSnapshot,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
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

function sameTask(
  left: DurableContinuationTaskSnapshot,
  right: DurableContinuationTaskSnapshot,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.projectId === right.projectId &&
    left.repository === right.repository &&
    left.issueNumber === right.issueNumber &&
    left.taskState === right.taskState &&
    left.activePullRequestNumber === right.activePullRequestNumber &&
    left.expectedHeadSha === right.expectedHeadSha &&
    left.priority === right.priority &&
    left.updatedAt === right.updatedAt
  );
}

function sameTaskSet(
  left: readonly DurableContinuationTaskSnapshot[],
  right: readonly DurableContinuationTaskSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByTask = new Map(right.map((task) => [task.taskId, task]));
  if (rightByTask.size !== right.length) return false;
  return left.every((task) => {
    const match = rightByTask.get(task.taskId);
    return match !== undefined && sameTask(task, match);
  });
}

function sameProposal(
  left: ContinuationNextTaskTransitionProposal,
  right: ContinuationNextTaskTransitionProposal,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.selectionEvidence.taskId === right.selectionEvidence.taskId &&
    left.selectionEvidence.issueNumber === right.selectionEvidence.issueNumber &&
    left.selectionEvidence.expectedMainSha === right.selectionEvidence.expectedMainSha &&
    left.selectionEvidence.observedAt === right.selectionEvidence.observedAt &&
    sameCampaign(left.campaign, right.campaign) &&
    sameTaskSet(left.tasks, right.tasks)
  );
}

function canonicalizeTransition(
  expected: ContinuationPostMergeTransitionProposal,
  transition: ContinuationNextTaskTransitionProposal,
): ContinuationNextTaskTransitionProposal {
  if (!expected || typeof expected !== "object" || !transition || typeof transition !== "object") {
    fail("INVALID_INPUT");
  }
  if (
    transition.schemaVersion !== 1 ||
    transition.kind !== "NEXT_TASK_TRANSITION" ||
    !transition.campaign ||
    typeof transition.campaign !== "object" ||
    !transition.selectionEvidence ||
    typeof transition.selectionEvidence !== "object"
  ) {
    fail("INVALID_TRANSITION");
  }

  const ready: ContinuationPlanResult = {
    kind: "READY",
    campaignId: transition.campaign.campaignId,
    projectId: transition.campaign.projectId,
    repository: transition.campaign.repository,
    taskId: transition.selectionEvidence.taskId,
    issueNumber: transition.selectionEvidence.issueNumber,
    expectedMainSha: transition.selectionEvidence.expectedMainSha,
    observedAt: transition.selectionEvidence.observedAt,
  };

  let canonical: ContinuationNextTaskTransitionProposal;
  try {
    canonical = planContinuationNextTaskTransition(expected, ready);
  } catch {
    fail("INVALID_TRANSITION");
  }

  if (!sameProposal(canonical, transition)) fail("INVALID_TRANSITION");
  if (canonical.tasks.length > MAX_CONTINUATION_CANDIDATES) fail("INVALID_TRANSITION");

  let policy;
  try {
    policy = requireManagedProjectPolicy(canonical.campaign.repository);
  } catch {
    fail("INVALID_TRANSITION");
  }
  if (
    policy.repository !== canonical.campaign.repository ||
    policy.id !== canonical.campaign.projectId
  ) {
    fail("INVALID_TRANSITION");
  }

  return canonical;
}

function buildCompareAndSwap(
  expected: ContinuationPostMergeTransitionProposal,
  target: ContinuationNextTaskTransitionProposal,
): BuiltStatement {
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `?${values.length}`;
  };

  const campaign = expected.campaign;
  const currentTaskId = campaign.currentTask?.taskId ?? null;
  const currentTaskState = campaign.currentTask?.state ?? null;

  const predicates = [
    `campaign_id = ${bind(campaign.campaignId)}`,
    `schema_version = ${bind(campaign.schemaVersion)}`,
    `project_id = ${bind(campaign.projectId)}`,
    `repository = ${bind(campaign.repository)}`,
    `scope = ${bind(campaign.scope)}`,
    `mode = ${bind(campaign.mode)}`,
    `continue_enabled = ${bind(campaign.continueEnabled ? 1 : 0)}`,
    `paused = ${bind(campaign.paused ? 1 : 0)}`,
    `expected_main_sha = ${bind(campaign.expectedMainSha)}`,
    `current_task_id IS ${bind(currentTaskId)}`,
    `current_task_state IS ${bind(currentTaskState)}`,
    `next_task_id IS ${bind(campaign.nextTaskId)}`,
    `human_gate IS ${bind(campaign.humanGate)}`,
    `observed_at = ${bind(campaign.observedAt)}`,
    `updated_at = ${bind(campaign.updatedAt)}`,
  ];

  const taskCountCampaign = bind(campaign.campaignId);
  const taskCountProject = bind(campaign.projectId);
  const taskCountRepository = bind(campaign.repository);
  const taskCount = bind(expected.tasks.length);
  predicates.push(`(
    SELECT COUNT(*)
    FROM continuation_tasks AS counted
    WHERE counted.campaign_id = ${taskCountCampaign}
      AND counted.project_id = ${taskCountProject}
      AND counted.repository = ${taskCountRepository}
  ) = ${taskCount}`);

  for (const task of expected.tasks) {
    const campaignId = bind(campaign.campaignId);
    const taskId = bind(task.taskId);
    const projectId = bind(task.projectId);
    const repository = bind(task.repository);
    const issueNumber = bind(task.issueNumber);
    const taskState = bind(task.taskState);
    const pullRequestNumber = bind(task.activePullRequestNumber);
    const expectedHeadSha = bind(task.expectedHeadSha);
    const priority = bind(task.priority);
    const updatedAt = bind(task.updatedAt);

    predicates.push(`EXISTS (
      SELECT 1
      FROM continuation_tasks AS expected_task
      WHERE expected_task.campaign_id = ${campaignId}
        AND expected_task.task_id = ${taskId}
        AND expected_task.project_id = ${projectId}
        AND expected_task.repository = ${repository}
        AND expected_task.issue_number = ${issueNumber}
        AND expected_task.task_state = ${taskState}
        AND expected_task.active_pull_request_number IS ${pullRequestNumber}
        AND expected_task.expected_head_sha IS ${expectedHeadSha}
        AND expected_task.priority = ${priority}
        AND expected_task.updated_at = ${updatedAt}
    )`);
  }

  const nextTaskId = bind(target.campaign.nextTaskId);
  const observedAt = bind(target.campaign.observedAt);
  const updatedAt = bind(target.campaign.updatedAt);

  return {
    sql: `
UPDATE continuation_campaigns
SET
  next_task_id = ${nextTaskId},
  observed_at = ${observedAt},
  updated_at = ${updatedAt}
WHERE
  ${predicates.join("\n  AND ")}
`.trim(),
    values,
  };
}

function successfulWrite(result: D1RunResultLike): number {
  if (!result || result.success !== true || !result.meta) fail("D1_WRITE_FAILED");
  const changes = result.meta.changes;
  if (changes !== 0 && changes !== 1) fail("D1_CHANGE_COUNT_INVALID");
  return changes;
}

function recoveredMatchesTarget(
  evidence: ContinuationCampaignRecoveryEvidence,
  target: ContinuationNextTaskTransitionProposal,
): boolean {
  return (
    evidence.kind === "FOUND" &&
    sameCampaign(evidence.campaign, target.campaign) &&
    sameTaskSet(evidence.tasks, target.tasks)
  );
}

/**
 * Persist only one already-authoritative READY -> nextTaskId reservation.
 *
 * The write is a single compare-and-swap UPDATE over the exact campaign and
 * complete bounded task set. It never starts a task, changes task rows, wires
 * runtime behavior, applies migrations, schedules work, merges, deploys or
 * grants authority for any later mutation.
 */
export class D1ContinuationNextTaskStore {
  readonly #database: D1DatabaseLike;
  readonly #reader: D1ContinuationCampaignReader;

  constructor(database: D1DatabaseLike) {
    if (!database || typeof database.prepare !== "function") fail("INVALID_INPUT");
    this.#database = database;
    this.#reader = new D1ContinuationCampaignReader(database);
  }

  async persist(
    expected: ContinuationPostMergeTransitionProposal,
    transition: ContinuationNextTaskTransitionProposal,
  ): Promise<ContinuationNextTaskPersistenceResult> {
    const target = canonicalizeTransition(expected, transition);
    const statement = buildCompareAndSwap(expected, target);

    let changes: number;
    try {
      const result = await this.#database.prepare(statement.sql).bind(...statement.values).run();
      changes = successfulWrite(result);
    } catch (error) {
      if (error instanceof D1ContinuationNextTaskStoreError) throw error;
      fail("D1_WRITE_FAILED");
    }

    let recovered: ContinuationCampaignRecoveryEvidence;
    try {
      recovered = await this.#reader.read({
        campaignId: target.campaign.campaignId,
        projectId: target.campaign.projectId,
        repository: target.campaign.repository,
        expectedMainSha: target.campaign.expectedMainSha,
      });
    } catch {
      if (changes === 1) fail("POSTWRITE_VERIFICATION_FAILED");
      fail("D1_RECOVERY_FAILED");
    }

    if (changes === 0) {
      if (recoveredMatchesTarget(recovered, target)) return { kind: "ALREADY_APPLIED" };
      fail("STALE_DURABLE_STATE");
    }

    if (!recoveredMatchesTarget(recovered, target)) fail("POSTWRITE_VERIFICATION_FAILED");
    return { kind: "APPLIED" };
  }
}
