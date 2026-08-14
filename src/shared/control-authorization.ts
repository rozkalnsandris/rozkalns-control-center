import { managedProjectPolicies } from "./project-policy.js";

export type ControlOperationId = "workflow_dispatch";
export type ControlGitHubPermission = "actions:write";

export interface ControlOperationPolicy {
  id: ControlOperationId;
  liveEnabled: boolean;
  requiredGitHubPermissions: readonly ControlGitHubPermission[];
  targetSelection: "source_controlled_allowlist";
}

export interface ControlAuthorization {
  projectId: string;
  repository: string;
  operation: ControlOperationId;
  expectedMainSha: string;
  expectedCiRunId: number;
}

export type ControlAuthorizationErrorCode =
  | "AUTHORIZATION_FORMAT_INVALID"
  | "PROJECT_NOT_MANAGED"
  | "OPERATION_NOT_ALLOWED"
  | "CI_RUN_ID_INVALID";

export class ControlAuthorizationError extends Error {
  constructor(
    readonly code: ControlAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ControlAuthorizationError";
  }
}

export const controlOperationPolicies = Object.freeze({
  workflow_dispatch: Object.freeze({
    id: "workflow_dispatch",
    liveEnabled: false,
    requiredGitHubPermissions: Object.freeze(["actions:write"]),
    targetSelection: "source_controlled_allowlist",
  }),
}) satisfies Readonly<Record<ControlOperationId, ControlOperationPolicy>>;

const authorizationPattern =
  /^authorize control ([a-z0-9-]+) (workflow_dispatch) ([0-9a-f]{40}) ci ([1-9][0-9]*)$/;

function findManagedProject(projectId: string) {
  return managedProjectPolicies.find(
    (policy) => policy.id === projectId && policy.enabled && policy.githubReadEnabled,
  );
}

export function parseControlAuthorization(input: string): ControlAuthorization {
  if (input.includes("\n") || input.includes("\r")) {
    throw new ControlAuthorizationError(
      "AUTHORIZATION_FORMAT_INVALID",
      "Control authorization must be exactly one line",
    );
  }

  const match = authorizationPattern.exec(input);
  if (!match) {
    throw new ControlAuthorizationError(
      "AUTHORIZATION_FORMAT_INVALID",
      "Control authorization format is invalid",
    );
  }

  const [, projectId, operationRaw, expectedMainSha, ciRunIdRaw] = match;
  const project = findManagedProject(projectId);
  if (!project) {
    throw new ControlAuthorizationError(
      "PROJECT_NOT_MANAGED",
      "Control authorization project is not managed",
    );
  }

  if (!(operationRaw in controlOperationPolicies)) {
    throw new ControlAuthorizationError(
      "OPERATION_NOT_ALLOWED",
      "Control authorization operation is not allowed",
    );
  }

  const operation = operationRaw as ControlOperationId;
  const expectedCiRunId = Number(ciRunIdRaw);
  if (!Number.isSafeInteger(expectedCiRunId) || expectedCiRunId <= 0) {
    throw new ControlAuthorizationError(
      "CI_RUN_ID_INVALID",
      "Control authorization CI run id is invalid",
    );
  }

  return {
    projectId: project.id,
    repository: project.repository,
    operation,
    expectedMainSha,
    expectedCiRunId,
  };
}

export function requireControlOperationPolicy(operation: ControlOperationId): ControlOperationPolicy {
  const policy = controlOperationPolicies[operation];
  if (!policy) {
    throw new ControlAuthorizationError(
      "OPERATION_NOT_ALLOWED",
      "Control authorization operation is not allowed",
    );
  }
  return policy;
}
