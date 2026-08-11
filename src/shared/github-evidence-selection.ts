import type { CheckRunRead, CommitStatusRead, WorkflowRunRead } from "./source-control-read.js";

function timestampMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maximalByProvableOrder<T>(items: readonly T[], isProvablyNewer: (left: T, right: T) => boolean): T[] {
  return items.filter((candidate, candidateIndex) =>
    !items.some((other, otherIndex) => otherIndex !== candidateIndex && isProvablyNewer(other, candidate)),
  );
}

function groupBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function checkOrderingTime(check: CheckRunRead): number | null {
  return timestampMs(check.startedAt) ?? timestampMs(check.completedAt);
}

function isCheckProvablyNewer(left: CheckRunRead, right: CheckRunRead): boolean {
  const leftTime = checkOrderingTime(left);
  const rightTime = checkOrderingTime(right);
  return leftTime !== null && rightTime !== null && leftTime > rightTime;
}

export function selectLatestEffectiveCheckRuns(checkRuns: readonly CheckRunRead[]): CheckRunRead[] {
  const groups = groupBy(checkRuns, (check) => `${check.name.toLowerCase()}\u0000${check.appId ?? "unknown"}`);
  return [...groups.values()].flatMap((group) => maximalByProvableOrder(group, isCheckProvablyNewer));
}

function isCommitStatusProvablyNewer(left: CommitStatusRead, right: CommitStatusRead): boolean {
  const leftTime = timestampMs(left.createdAt);
  const rightTime = timestampMs(right.createdAt);
  return leftTime !== null && rightTime !== null && leftTime > rightTime;
}

export function selectLatestEffectiveCommitStatuses(statuses: readonly CommitStatusRead[]): CommitStatusRead[] {
  const groups = groupBy(statuses, (status) => status.context.toLowerCase());
  return [...groups.values()].flatMap((group) => maximalByProvableOrder(group, isCommitStatusProvablyNewer));
}

function isWorkflowRunProvablyNewer(left: WorkflowRunRead, right: WorkflowRunRead): boolean {
  if (left.workflowId !== right.workflowId) return false;
  if (left.runNumber !== right.runNumber) return left.runNumber > right.runNumber;
  if (left.runAttempt !== right.runAttempt) return left.runAttempt > right.runAttempt;

  const leftUpdated = timestampMs(left.updatedAt);
  const rightUpdated = timestampMs(right.updatedAt);
  if (leftUpdated !== null && rightUpdated !== null && leftUpdated !== rightUpdated) return leftUpdated > rightUpdated;

  const leftStarted = timestampMs(left.runStartedAt) ?? timestampMs(left.createdAt);
  const rightStarted = timestampMs(right.runStartedAt) ?? timestampMs(right.createdAt);
  return leftStarted !== null && rightStarted !== null && leftStarted > rightStarted;
}

export function selectLatestEffectiveWorkflowRuns(workflowRuns: readonly WorkflowRunRead[]): WorkflowRunRead[] {
  const groups = groupBy(workflowRuns, (run) => run.workflowId);
  return [...groups.values()].flatMap((group) => maximalByProvableOrder(group, isWorkflowRunProvablyNewer));
}
