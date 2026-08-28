import type { DecisionReadModel, MockAction, ProjectReadModel } from "../shared/control-model";
import { laterDecisionStateFingerprint } from "../shared/later-decision";

export type MutatingDecisionAction = Exclude<MockAction, "OPEN_PR">;

export interface DecisionActionTarget {
  action: MutatingDecisionAction;
  item: DecisionReadModel;
  project: ProjectReadModel;
}

export interface DecisionActionRequest {
  path: "/api/github/merge" | "/api/github/needs-changes" | "/api/github/later";
  body: Record<string, unknown>;
}

export interface DecisionActionRequestOptions {
  reviewBody?: string;
  requestIdFactory?: (action: "MERGE" | "NEEDS_CHANGES") => string;
}

export class DecisionActionClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Decision action failed");
    this.name = "DecisionActionClientError";
    this.code = code;
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const REVIEW_BODY_MAX_BYTES = 4096;

function fail(code: string): never {
  throw new DecisionActionClientError(code);
}

function requirePositiveInteger(value: number | null): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail("INVALID_DECISION_IDENTITY");
  return Number(value);
}

function requireSha(value: string | null): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail("INVALID_DECISION_SHA");
  return value;
}

function requireExactHead(item: DecisionReadModel): string {
  const expected = requireSha(item.expectedHeadSha);
  const current = requireSha(item.currentHeadSha);
  if (expected !== current) fail("STALE_DECISION_HEAD");
  return expected;
}

function requireRequestId(value: string): string {
  if (!REQUEST_ID_PATTERN.test(value)) fail("INVALID_REQUEST_ID");
  return value;
}

function defaultRequestId(action: "MERGE" | "NEEDS_CHANGES"): string {
  const prefix = action === "MERGE" ? "rcmerge_" : "rcneeds_";
  return `${prefix}${crypto.randomUUID().replaceAll("-", "_")}`;
}

function requireReviewBody(value: string | undefined): string {
  if (typeof value !== "string") fail("REVIEW_MESSAGE_REQUIRED");
  const normalized = value.trim();
  if (normalized.length === 0) fail("REVIEW_MESSAGE_REQUIRED");
  if ([...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 127;
  })) {
    fail("INVALID_REVIEW_MESSAGE");
  }
  if (new TextEncoder().encode(normalized).byteLength > REVIEW_BODY_MAX_BYTES) {
    fail("REVIEW_MESSAGE_TOO_LONG");
  }
  return normalized;
}

function requireActionStillAllowed(target: DecisionActionTarget): void {
  if (!target.item.allowedActions.includes(target.action)) fail("ACTION_NOT_ALLOWED");
  if (target.item.projectId !== target.project.id) fail("PROJECT_IDENTITY_MISMATCH");
  if (target.project.repository.trim() === "") fail("PROJECT_IDENTITY_MISMATCH");
}

export function buildDecisionActionRequest(
  target: DecisionActionTarget,
  options: DecisionActionRequestOptions = {},
): DecisionActionRequest {
  requireActionStillAllowed(target);

  if (target.action === "LATER") {
    return {
      path: "/api/github/later",
      body: {
        repository: target.project.repository,
        decisionId: target.item.id,
        expectedStateFingerprint: laterDecisionStateFingerprint(target.item),
      },
    };
  }

  const issueNumber = requirePositiveInteger(target.item.issueNumber);
  const pullNumber = requirePositiveInteger(target.item.prNumber);
  const expectedHeadSha = requireExactHead(target.item);
  const expectedMainSha = requireSha(target.item.mainSha);
  const requestIdFactory = options.requestIdFactory ?? defaultRequestId;
  const requestId = requireRequestId(requestIdFactory(target.action));

  if (target.action === "MERGE") {
    return {
      path: "/api/github/merge",
      body: {
        repository: target.project.repository,
        issueNumber,
        pullNumber,
        expectedHeadSha,
        expectedMainSha,
        requestId,
        mergeMethod: "squash",
      },
    };
  }

  return {
    path: "/api/github/needs-changes",
    body: {
      repository: target.project.repository,
      issueNumber,
      pullNumber,
      expectedHeadSha,
      expectedMainSha,
      requestId,
      body: requireReviewBody(options.reviewBody),
    },
  };
}

function safeServerCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const code = (payload as Record<string, unknown>).error;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : null;
}

export async function postDecisionAction(
  target: DecisionActionTarget,
  options: DecisionActionRequestOptions = {},
): Promise<{ path: DecisionActionRequest["path"]; status: number }> {
  const request = buildDecisionActionRequest(target, options);
  const response = await fetch(request.path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request.body),
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    fail(safeServerCode(payload) ?? `HTTP_${response.status}`);
  }

  return { path: request.path, status: response.status };
}

export function decisionActionErrorMessage(error: unknown): string {
  if (!(error instanceof DecisionActionClientError)) {
    return "Action failed before a verified result was available";
  }

  const messages: Record<string, string> = {
    INVALID_DECISION_IDENTITY: "Decision identity is incomplete",
    INVALID_DECISION_SHA: "Decision SHA evidence is incomplete",
    STALE_DECISION_HEAD: "Decision head changed; refresh required",
    PROJECT_IDENTITY_MISMATCH: "Decision project identity is inconsistent",
    REVIEW_MESSAGE_REQUIRED: "Add a review message before requesting changes",
    REVIEW_MESSAGE_TOO_LONG: "Review message is too long",
    INVALID_REVIEW_MESSAGE: "Review message contains unsupported characters",
    AUTHENTICATION_FAILED: "Authentication failed",
    AUTHORIZATION_STALE_STATE: "Decision state changed; refresh required",
    AUTHORIZATION_STALE_HEAD: "Pull request head changed; refresh required",
    AUTHORIZATION_STALE_BASE: "Main changed; refresh required",
    ACTION_NOT_ALLOWED: "Action is not enabled for this project",
    PERSISTENCE_CONFLICT: "Decision changed while the action was being recorded",
  };

  return messages[error.code] ?? `Action failed (${error.code})`;
}
