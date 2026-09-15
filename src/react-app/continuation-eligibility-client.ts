import type { ContinuationActionTarget, DecisionActionState, DecisionReadModel, ProjectReadModel } from "../shared/control-model.js";
import { disabledAction, decisionSnapshotBlock } from "../shared/decision-action-model.js";

export interface ContinuationEligibility {
  continuation?: ContinuationActionTarget;
  states: { CONTINUE: DecisionActionState; PAUSE: DecisionActionState };
}
const blocked = (reason: string): ContinuationEligibility => ({ states: { CONTINUE: disabledAction(reason), PAUSE: disabledAction(reason) } });
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function state(value: unknown): value is DecisionActionState {
  if (!record(value) || Object.keys(value).sort().join(",") !== "reason,state") return false;
  return value.state === "enabled" ? value.reason === null : (value.state === "disabled" || value.state === "unavailable") && typeof value.reason === "string" && value.reason.trim().length > 0 && value.reason.length <= 240;
}
export async function readContinuationEligibility(item: DecisionReadModel, project: ProjectReadModel, signal: AbortSignal): Promise<ContinuationEligibility> {
  if (decisionSnapshotBlock(item)) return blocked("Stale snapshot");
  try {
    const query = new URLSearchParams({ repository: project.repository, decisionId: item.id, expectedMainSha: item.mainSha });
    const response = await fetch(`/api/control/continuation/preflight?${query}`, { signal, method: "GET", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) {
      const reason = response.status === 503 ? "Continuation disabled or runtime unavailable" : "Continuation state unavailable or not applicable";
      return blocked(reason);
    }
    const value: unknown = await response.json();
    if (!record(value) || value.repository !== project.repository || value.decisionId !== item.id || typeof value.observedAt !== "string") return blocked("Invalid continuation evidence");
    const age = Date.now() - Date.parse(value.observedAt);
    const target = value.continuation;
    const states = value.states;
    if (!Number.isFinite(age) || age < 0 || age > 60_000 || !record(target) || Object.keys(target).sort().join(",") !== "campaignId,expectedMainSha,revision" || typeof target.campaignId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(target.campaignId) || typeof target.revision !== "string" || !/^[0-9a-f]{64}$/.test(target.revision) || target.expectedMainSha !== item.mainSha || !record(states) || Object.keys(states).sort().join(",") !== "CONTINUE,PAUSE" || !state(states.CONTINUE) || !state(states.PAUSE)) return blocked("Invalid continuation evidence");
    return { continuation: { campaignId: target.campaignId, revision: target.revision, expectedMainSha: item.mainSha }, states: { CONTINUE: states.CONTINUE, PAUSE: states.PAUSE } };
  } catch { return blocked("Continuation live read failed"); }
}
