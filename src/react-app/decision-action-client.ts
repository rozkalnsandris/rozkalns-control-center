import type { DecisionReadModel, ProjectReadModel } from "../shared/control-model.js";
import type { OwnerAction } from "../shared/owner-action-model.js";
import { resolveOwnerWorkflowTarget } from "../shared/project-policy.js";

export type MutatingDecisionAction = OwnerAction;

export interface DecisionActionTarget {
  action: MutatingDecisionAction;
  item: DecisionReadModel;
  project: ProjectReadModel;
}

export interface DecisionActionRequest {
  path: "/api/github/merge" | "/api/github/owner-action";
  body: Record<string, unknown>;
}

export interface DecisionActionRequestOptions {
  requestIdFactory?: (action: MutatingDecisionAction) => string;
}

export class DecisionActionClientError extends Error {
  readonly code: string;
  constructor(code: string) { super("Decision action failed"); this.name = "DecisionActionClientError"; this.code = code; }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
function fail(code: string): never { throw new DecisionActionClientError(code); }
function requirePositiveInteger(value: number | null): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) fail("INVALID_DECISION_IDENTITY"); return Number(value); }
function requireSha(value: string | null): string { if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail("INVALID_DECISION_SHA"); return value; }
function requireExactHead(item: DecisionReadModel): string { const expected = requireSha(item.expectedHeadSha); const current = requireSha(item.currentHeadSha); if (expected !== current) fail("STALE_DECISION_HEAD"); return expected; }
function requireRequestId(value: string): string { if (!REQUEST_ID_PATTERN.test(value)) fail("INVALID_REQUEST_ID"); return value; }
function defaultRequestId(action: MutatingDecisionAction): string { return `rc_${action.toLowerCase()}_${crypto.randomUUID().replace(/-/g, "_")}`; }

function requireActionStillAllowed(target: DecisionActionTarget): void {
  const expires = target.item.actionEligibilityExpiresAt;
  if (expires !== undefined && (!Number.isFinite(expires) || Date.now() > expires)) fail("ACTION_ELIGIBILITY_EXPIRED");
  if (target.item.projectId !== target.project.id || target.project.repository.trim() === "") fail("PROJECT_IDENTITY_MISMATCH");
  if (target.action === "MERGE") {
    if (target.item.actionStates?.MERGE.state !== "enabled" || !target.item.allowedActions.includes("MERGE")) fail("ACTION_NOT_ALLOWED");
    return;
  }
  if (!resolveOwnerWorkflowTarget(target.project.repository, target.action)) fail("ACTION_NOT_ALLOWED");
}

export function buildDecisionActionRequest(target: DecisionActionTarget, options: DecisionActionRequestOptions = {}): DecisionActionRequest {
  requireActionStillAllowed(target);
  const requestId = requireRequestId((options.requestIdFactory ?? defaultRequestId)(target.action));
  const expectedMainSha = requireSha(target.item.mainSha);
  if (target.action === "LIVE" || target.action === "CONTINUE") {
    return {
      path: "/api/github/owner-action",
      body: { action: target.action, repository: target.project.repository, expectedMainSha, requestId },
    };
  }
  return {
    path: "/api/github/merge",
    body: {
      repository: target.project.repository,
      issueNumber: requirePositiveInteger(target.item.issueNumber),
      pullNumber: requirePositiveInteger(target.item.prNumber),
      expectedHeadSha: requireExactHead(target.item),
      expectedMainSha,
      requestId,
      mergeMethod: "squash",
    },
  };
}

function safeServerCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const code = (payload as Record<string, unknown>).error;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : null;
}

export async function postDecisionAction(target: DecisionActionTarget, options: DecisionActionRequestOptions = {}): Promise<{ path: DecisionActionRequest["path"]; status: number }> {
  const request = buildDecisionActionRequest(target, options);
  const response = await fetch(request.path, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
  if (!response.ok) { const payload: unknown = await response.json().catch(() => null); fail(safeServerCode(payload) ?? `HTTP_${response.status}`); }
  return { path: request.path, status: response.status };
}

export function decisionActionErrorMessage(error: unknown): string {
  if (!(error instanceof DecisionActionClientError)) return "Action failed before a verified result was available";
  const messages: Record<string, string> = {
    ACTION_ELIGIBILITY_EXPIRED: "Action eligibility expired; refresh required",
    INVALID_DECISION_IDENTITY: "Decision identity is incomplete",
    INVALID_DECISION_SHA: "Decision SHA evidence is incomplete",
    STALE_DECISION_HEAD: "Decision head changed; refresh required",
    PROJECT_IDENTITY_MISMATCH: "Decision project identity is inconsistent",
    INVALID_REQUEST_ID: "Action request identity is invalid",
    AUTHENTICATION_FAILED: "Authentication failed",
    ACCESS_AUTHENTICATION_FAILED: "Authentication failed",
    AUTHORIZATION_STALE_STATE: "Decision state changed; refresh required",
    AUTHORIZATION_STALE_HEAD: "Pull request head changed; refresh required",
    AUTHORIZATION_STALE_BASE: "Main changed; refresh required",
    STALE_MAIN_SHA: "Main changed; refresh required",
    ACTION_NOT_ALLOWED: "Action is not enabled for this project",
    ACTIONS_PERMISSION_REQUIRED: "GitHub App Actions write permission is not active",
  };
  return messages[error.code] ?? `Action failed (${error.code})`;
}
