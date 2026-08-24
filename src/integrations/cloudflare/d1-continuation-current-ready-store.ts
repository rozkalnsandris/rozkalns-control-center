import type { ContinuationPlanResult } from "../../shared/continuation-plan.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  planContinuationCurrentReadyTransition,
  type ContinuationCurrentReadyTransitionProposal,
} from "./continuation-current-ready-transition.js";
import {
  D1ContinuationCampaignReader,
  type ContinuationCampaignRecoveryEvidence,
  type DurableContinuationCampaignSnapshot,
  type DurableContinuationTaskSnapshot,
} from "./d1-continuation-campaign-reader.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./d1-delivery-claim-store.js";

export interface D1BatchDatabaseLike extends D1DatabaseLike {
  batch(
    statements: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1RunResultLike[]>;
}

export type ContinuationCurrentReadyPersistenceResult =
  | { readonly kind: "APPLIED" }
  | { readonly kind: "ALREADY_APPLIED" };

export type D1ContinuationCurrentReadyStoreErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "D1_PREREAD_FAILED"
  | "STALE_DURABLE_STATE"
  | "D1_BATCH_FAILED"
  | "D1_CHANGE_COUNT_INVALID"
  | "POSTWRITE_VERIFICATION_FAILED";

export class D1ContinuationCurrentReadyStoreError extends Error {
  readonly code: D1ContinuationCurrentReadyStoreErrorCode;

  constructor(code: D1ContinuationCurrentReadyStoreErrorCode) {
    super("Continuation current READY persistence failed closed");
    this.name = "D1ContinuationCurrentReadyStoreError";
    this.code = code;
  }
}

interface BuiltStatement {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function fail(code: D1ContinuationCurrentReadyStoreErrorCode): never {
  throw new D1ContinuationCurrentReadyStoreError(code);
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

function sameEvidence(
  evidence: ContinuationCampaignRecoveryEvidence,
  campaign: DurableContinuationCampaignSnapshot,
  tasks: readonly DurableContinuationTaskSnapshot[],
): boolean {
  return (
    evidence.kind === "FOUND" &&
    sameCampaign(evidence.campaign, campaign) &&
    sameTaskSet(evidence.tasks, tasks)
  );
}

function sameProposal(
  left: ContinuationCurrentReadyTransitionProposal,
  right: ContinuationCurrentReadyTransitionProposal,
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
  expected: ContinuationCampaignRecoveryEvidence,
  transition: ContinuationCurrentReadyTransitionProposal,
): ContinuationCurrentReadyTransitionProposal {
  if (
    !expected ||
    typeof expected !== "object" ||
    expected.kind !== "FOUND" ||
    !transition ||
    typeof transition !== "object" ||
    transition.schemaVersion !== 1 ||
    transition.kind !== "CURRENT_READY_TRANSITION" ||
    !transition.campaign ||
    typeof transition.campaign !== "object" ||
    !transition.selectionEvidence ||
    typeof transition.selectionEvidence !== "object"
  ) {
    fail("INVALID_INPUT");
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

  let canonical: ContinuationCurrentReadyTransitionProposal;
  try {
    canonical = planContinuationCurrentReadyTransition(expected, ready);
  } catch {
    fail("INVALID_TRANSITION");
  }
  if (!sameProposal(canonical, transition)) fail("INVALID_TRANSITION");

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

function addCampaignPredicates(
  values: unknown[],
  campaign: DurableContinuationCampaignSnapshot,
  tasks: readonly DurableContinuationTaskSnapshot[],
): string[] {
  const bind = (value: unknown): string => {
    values.push(value);
    return `?${values.length}`;
  };
  const predicates = [
    `schema_version = ${bind(campaign.schemaVersion)}`,
    `project_id = ${bind(campaign.projectId)}`,
    `repository = ${bind(campaign.repository)}`,
    `scope = ${bind(campaign.scope)}`,
    `mode = ${bind(campaign.mode)}`,
    `continue_enabled = ${bind(campaign.continueEnabled ? 1 : 0)}`,
    `paused = ${bind(campaign.paused ? 1 : 0)}`,
    `expected_main_sha = ${bind(campaign.expectedMainSha)}`,
    `current_task_id IS ${bind(campaign.currentTask?.taskId ?? null)}`,
    `current_task_state IS ${bind(campaign.currentTask?.state ?? null)}`,
    `next_task_id IS ${bind(campaign.nextTaskId)}`,
    `human_gate IS ${bind(campaign.humanGate)}`,
    `observed_at = ${bind(campaign.observedAt)}`,
    `updated_at = ${bind(campaign.updatedAt)}`,
  ];

  predicates.push(`(
    SELECT COUNT(*) FROM continuation_tasks AS counted
    WHERE counted.campaign_id = ${bind(campaign.campaignId)}
      AND counted.project_id = ${bind(campaign.projectId)}
      AND counted.repository = ${bind(campaign.repository)}
  ) = ${bind(tasks.length)}`);

  for (const task of tasks) {
    predicates.push(`EXISTS (
      SELECT 1 FROM continuation_tasks AS expected_task
      WHERE expected_task.campaign_id = ${bind(campaign.campaignId)}
        AND expected_task.task_id = ${bind(task.taskId)}
        AND expected_task.project_id = ${bind(task.projectId)}
        AND expected_task.repository = ${bind(task.repository)}
        AND expected_task.issue_number = ${bind(task.issueNumber)}
        AND expected_task.task_state = ${bind(task.taskState)}
        AND expected_task.active_pull_request_number IS ${bind(task.activePullRequestNumber)}
        AND expected_task.expected_head_sha IS ${bind(task.expectedHeadSha)}
        AND expected_task.priority = ${bind(task.priority)}
        AND expected_task.updated_at = ${bind(task.updatedAt)}
    )`);
  }
  return predicates;
}

function buildCampaignCompareAndSwap(
  expected: ContinuationCampaignRecoveryEvidence & { readonly kind: "FOUND" },
  target: ContinuationCurrentReadyTransitionProposal,
): BuiltStatement {
  const values: unknown[] = [];
  const predicates = addCampaignPredicates(values, expected.campaign, expected.tasks);
  const bind = (value: unknown): string => {
    values.push(value);
    return `?${values.length}`;
  };
  const currentTask = target.campaign.currentTask;
  if (currentTask === null) fail("INVALID_TRANSITION");

  const targetCurrentTaskId = bind(currentTask.taskId);
  const targetCurrentTaskState = bind(currentTask.state);
  const targetNextTaskId = bind(target.campaign.nextTaskId);
  const targetObservedAt = bind(target.campaign.observedAt);
  const targetUpdatedAt = bind(target.campaign.updatedAt);
  const campaignId = bind(expected.campaign.campaignId);

  return {
    sql: `
UPDATE continuation_campaigns
SET
  schema_version = CASE WHEN (${predicates.join(" AND ")}) THEN schema_version ELSE 0 END,
  current_task_id = ${targetCurrentTaskId},
  current_task_state = ${targetCurrentTaskState},
  next_task_id = ${targetNextTaskId},
  observed_at = ${targetObservedAt},
  updated_at = ${targetUpdatedAt}
WHERE campaign_id = ${campaignId}
`.trim(),
    values,
  };
}

function buildSelectedTaskCompareAndSwap(
  expected: ContinuationCampaignRecoveryEvidence & { readonly kind: "FOUND" },
  target: ContinuationCurrentReadyTransitionProposal,
): BuiltStatement {
  const taskId = target.selectionEvidence.taskId;
  const expectedTask = expected.tasks.find((task) => task.taskId === taskId);
  const targetTask = target.tasks.find((task) => task.taskId === taskId);
  const currentTask = target.campaign.currentTask;
  if (!expectedTask || !targetTask || currentTask === null) {
    fail("INVALID_TRANSITION");
  }

  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `?${values.length}`;
  };

  const taskPredicates = [
    `project_id = ${bind(expectedTask.projectId)}`,
    `repository = ${bind(expectedTask.repository)}`,
    `issue_number = ${bind(expectedTask.issueNumber)}`,
    `task_state = ${bind(expectedTask.taskState)}`,
    `active_pull_request_number IS ${bind(expectedTask.activePullRequestNumber)}`,
    `expected_head_sha IS ${bind(expectedTask.expectedHeadSha)}`,
    `priority = ${bind(expectedTask.priority)}`,
    `updated_at = ${bind(expectedTask.updatedAt)}`,
  ];

  const campaign = target.campaign;
  taskPredicates.push(`EXISTS (
    SELECT 1 FROM continuation_campaigns AS target_campaign
    WHERE target_campaign.campaign_id = ${bind(campaign.campaignId)}
      AND target_campaign.schema_version = ${bind(campaign.schemaVersion)}
      AND target_campaign.project_id = ${bind(campaign.projectId)}
      AND target_campaign.repository = ${bind(campaign.repository)}
      AND target_campaign.scope = ${bind(campaign.scope)}
      AND target_campaign.mode = ${bind(campaign.mode)}
      AND target_campaign.continue_enabled = ${bind(campaign.continueEnabled ? 1 : 0)}
      AND target_campaign.paused = ${bind(campaign.paused ? 1 : 0)}
      AND target_campaign.expected_main_sha = ${bind(campaign.expectedMainSha)}
      AND target_campaign.current_task_id = ${bind(currentTask.taskId)}
      AND target_campaign.current_task_state = ${bind(currentTask.state)}
      AND target_campaign.next_task_id IS ${bind(campaign.nextTaskId)}
      AND target_campaign.human_gate IS ${bind(campaign.humanGate)}
      AND target_campaign.observed_at = ${bind(campaign.observedAt)}
      AND target_campaign.updated_at = ${bind(campaign.updatedAt)}
  )`);

  const targetState = bind(targetTask.taskState);
  const targetUpdatedAt = bind(targetTask.updatedAt);
  const campaignId = bind(campaign.campaignId);
  const selectedTaskId = bind(taskId);

  return {
    sql: `
UPDATE continuation_tasks
SET
  priority = CASE WHEN (${taskPredicates.join(" AND ")}) THEN priority ELSE -1 END,
  task_state = ${targetState},
  updated_at = ${targetUpdatedAt}
WHERE campaign_id = ${campaignId} AND task_id = ${selectedTaskId}
`.trim(),
    values,
  };
}

function validateBatchResults(results: readonly D1RunResultLike[]): void {
  if (results.length !== 2) fail("D1_CHANGE_COUNT_INVALID");
  for (const result of results) {
    if (!result || result.success !== true || !result.meta) fail("D1_BATCH_FAILED");
    if (result.meta.changes !== 1) fail("D1_CHANGE_COUNT_INVALID");
  }
}

/**
 * Persist one already-canonical reserved-next -> current READY transition.
 *
 * The store remains detached from the continuation runtime. It performs an
 * idempotency pre-read, then one transactional two-statement D1 batch. Each
 * statement contains a CHECK-constraint abort guard so stale evidence causes
 * the whole batch to roll back instead of leaving campaign/task half-state.
 */
export class D1ContinuationCurrentReadyStore {
  readonly #database: D1BatchDatabaseLike;
  readonly #reader: D1ContinuationCampaignReader;

  constructor(database: D1BatchDatabaseLike) {
    if (
      !database ||
      typeof database.prepare !== "function" ||
      typeof database.batch !== "function"
    ) {
      fail("INVALID_INPUT");
    }
    this.#database = database;
    this.#reader = new D1ContinuationCampaignReader(database);
  }

  async persist(
    expected: ContinuationCampaignRecoveryEvidence,
    transition: ContinuationCurrentReadyTransitionProposal,
  ): Promise<ContinuationCurrentReadyPersistenceResult> {
    const target = canonicalizeTransition(expected, transition);
    if (expected.kind !== "FOUND") fail("INVALID_INPUT");

    let before: ContinuationCampaignRecoveryEvidence;
    try {
      before = await this.#reader.read({
        campaignId: target.campaign.campaignId,
        projectId: target.campaign.projectId,
        repository: target.campaign.repository,
        expectedMainSha: target.campaign.expectedMainSha,
      });
    } catch {
      fail("D1_PREREAD_FAILED");
    }

    if (sameEvidence(before, target.campaign, target.tasks)) {
      return { kind: "ALREADY_APPLIED" };
    }
    if (!sameEvidence(before, expected.campaign, expected.tasks)) {
      fail("STALE_DURABLE_STATE");
    }

    const campaignStatement = buildCampaignCompareAndSwap(expected, target);
    const taskStatement = buildSelectedTaskCompareAndSwap(expected, target);

    let results: readonly D1RunResultLike[];
    try {
      results = await this.#database.batch([
        this.#database.prepare(campaignStatement.sql).bind(...campaignStatement.values),
        this.#database.prepare(taskStatement.sql).bind(...taskStatement.values),
      ]);
    } catch {
      fail("D1_BATCH_FAILED");
    }
    validateBatchResults(results);

    let after: ContinuationCampaignRecoveryEvidence;
    try {
      after = await this.#reader.read({
        campaignId: target.campaign.campaignId,
        projectId: target.campaign.projectId,
        repository: target.campaign.repository,
        expectedMainSha: target.campaign.expectedMainSha,
      });
    } catch {
      fail("POSTWRITE_VERIFICATION_FAILED");
    }
    if (!sameEvidence(after, target.campaign, target.tasks)) {
      fail("POSTWRITE_VERIFICATION_FAILED");
    }

    return { kind: "APPLIED" };
  }
}
