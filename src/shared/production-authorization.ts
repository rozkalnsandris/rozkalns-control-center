import { managedProjectPolicies } from "./project-policy.js";

export const CONTROL_AUTHORIZATION_PREFIX = "authorize control";

export type ProductionExecutor = "github-actions-dispatch" | "cloudflare-d1" | "rpi5-controller";
export type ProductionOperationState = "disabled" | "enabled" | "retired";

export interface GitHubWorkflowDispatchTarget {
  repository: string;
  workflowFile: string;
  ref: "main";
  allowedInputNames: readonly string[];
}

interface ProductionOperationBase {
  id: string;
  projectId: string;
  repository: string;
  executor: ProductionExecutor;
  state: ProductionOperationState;
  requiresExactMainSha: true;
  requiresExactMainCi: true;
}

export interface DisabledGitHubWorkflowDispatchOperation extends ProductionOperationBase {
  executor: "github-actions-dispatch";
  state: "disabled";
  target: null;
  requiredGitHubAppPermissions: Readonly<{ actions: "write" }>;
}

export interface EnabledGitHubWorkflowDispatchOperation extends ProductionOperationBase {
  executor: "github-actions-dispatch";
  state: "enabled";
  target: GitHubWorkflowDispatchTarget;
  requiredGitHubAppPermissions: Readonly<{ actions: "write" }>;
}

export interface RetiredProductionOperation extends ProductionOperationBase {
  state: "retired";
  target: Readonly<Record<string, string>>;
  requiredGitHubAppPermissions: Readonly<Record<string, never>>;
}

export type ProductionOperation =
  | DisabledGitHubWorkflowDispatchOperation
  | EnabledGitHubWorkflowDispatchOperation
  | RetiredProductionOperation;

export interface ParsedProductionAuthorization {
  raw: string;
  operationId: string;
  expectedMainSha: string;
  expectedCiRunId: string;
}

export interface ResolvedProductionAuthorization extends ParsedProductionAuthorization {
  operation: EnabledGitHubWorkflowDispatchOperation;
}

export type ProductionAuthorizationErrorCode =
  | "AUTHORIZATION_FORMAT_INVALID"
  | "OPERATION_UNKNOWN"
  | "OPERATION_DISABLED"
  | "OPERATION_RETIRED";

export class ProductionAuthorizationError extends Error {
  constructor(
    public readonly code: ProductionAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProductionAuthorizationError";
  }
}

function disabledWorkflowDispatchOperation(
  project: (typeof managedProjectPolicies)[number],
): DisabledGitHubWorkflowDispatchOperation {
  return {
    id: `${project.id}.workflow-dispatch`,
    projectId: project.id,
    repository: project.repository,
    executor: "github-actions-dispatch",
    state: "disabled",
    target: null,
    requiredGitHubAppPermissions: { actions: "write" },
    requiresExactMainSha: true,
    requiresExactMainCi: true,
  };
}

const disabledManagedWorkflowDispatchOperations = managedProjectPolicies.map(
  disabledWorkflowDispatchOperation,
);

const retiredInitialD1Migration: RetiredProductionOperation = {
  id: "control.initial-production-d1-migration",
  projectId: "control-plane",
  repository: "rozkalnsandris/rozkalns-control-center",
  executor: "cloudflare-d1",
  state: "retired",
  target: { database: "rozkalns-control-production", migration: "0001_reconciliation_core.sql" },
  requiredGitHubAppPermissions: {},
  requiresExactMainSha: true,
  requiresExactMainCi: true,
};

export const productionOperationRegistry = [
  ...disabledManagedWorkflowDispatchOperations,
  retiredInitialD1Migration,
] as const satisfies readonly ProductionOperation[];

const operationById = new Map<string, ProductionOperation>();
for (const operation of productionOperationRegistry) {
  if (operationById.has(operation.id)) {
    throw new Error(`Duplicate production operation id: ${operation.id}`);
  }
  operationById.set(operation.id, operation);
}

const authorizationPattern = new RegExp(
  `^${CONTROL_AUTHORIZATION_PREFIX} ([a-z0-9][a-z0-9.-]{2,63}) ([0-9a-f]{40}) ci ([1-9][0-9]*)$`,
);

export function parseProductionAuthorizationSyntax(input: string): ParsedProductionAuthorization {
  const match = authorizationPattern.exec(input);
  if (!match) {
    throw new ProductionAuthorizationError(
      "AUTHORIZATION_FORMAT_INVALID",
      `Authorization must exactly match: ${CONTROL_AUTHORIZATION_PREFIX} <operation-id> <exact-main-sha> ci <exact-ci-run-id>`,
    );
  }

  return {
    raw: input,
    operationId: match[1],
    expectedMainSha: match[2],
    expectedCiRunId: match[3],
  };
}

export function getProductionOperation(operationId: string): ProductionOperation | null {
  return operationById.get(operationId) ?? null;
}

export function resolveProductionAuthorization(input: string): ResolvedProductionAuthorization {
  const parsed = parseProductionAuthorizationSyntax(input);
  const operation = getProductionOperation(parsed.operationId);
  if (!operation) {
    throw new ProductionAuthorizationError(
      "OPERATION_UNKNOWN",
      `Production operation is not present in the source-controlled registry: ${parsed.operationId}`,
    );
  }
  if (operation.state === "retired") {
    throw new ProductionAuthorizationError(
      "OPERATION_RETIRED",
      `Production operation is retired and cannot be authorized again: ${operation.id}`,
    );
  }
  if (operation.state !== "enabled") {
    throw new ProductionAuthorizationError(
      "OPERATION_DISABLED",
      `Production operation is disabled and has no executable target: ${operation.id}`,
    );
  }

  return { ...parsed, operation };
}
