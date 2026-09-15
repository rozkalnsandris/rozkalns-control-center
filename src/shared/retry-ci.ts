import { RETRY_CI_UNAVAILABLE_REASON, unavailableAction } from "./decision-action-model.js";
import type { DecisionActionState } from "./control-model.js";

export interface RetryCiExecution {
  repository: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "failure" | "timed_out" | "success" | "cancelled" | null;
  observedAt: string;
}
/** No write transport exists until a separate reviewed Actions: write capability gate. */
export function retryCiEligibility(expected: RetryCiExecution, observed: RetryCiExecution, nowMs: number): DecisionActionState {
  const age = nowMs - Date.parse(observed.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60_000) return unavailableAction("Stale or invalid CI execution evidence");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository) ||
    !Number.isSafeInteger(expected.runId) || expected.runId <= 0 || !Number.isSafeInteger(expected.runAttempt) || expected.runAttempt <= 0 || !/^[0-9a-f]{40}$/.test(expected.headSha) ||
    expected.repository !== observed.repository || expected.runId !== observed.runId || expected.runAttempt !== observed.runAttempt || expected.headSha !== observed.headSha) return unavailableAction("CI execution identity or attempt changed");
  if (observed.status !== "completed" || (observed.conclusion !== "failure" && observed.conclusion !== "timed_out")) return unavailableAction("CI execution is not eligible for retry");
  return unavailableAction(RETRY_CI_UNAVAILABLE_REASON);
}
