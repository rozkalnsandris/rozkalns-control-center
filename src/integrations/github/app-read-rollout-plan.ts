import {
  explicitlyExcludedRepositories,
  managedProjectPolicies,
} from "../../shared/project-policy.js";
import {
  parseGitHubInstallationReadScope,
  phase2GitHubReadPermissions,
  type GitHubInstallationReadScope,
  type Phase2GitHubReadPermission,
} from "./app-installation-read-contract.js";

export const GITHUB_CONTROL_APP_NAME = "Rozkalns Control" as const;
export const GITHUB_CONTROL_REPOSITORY_SELECTION = "selected" as const;
export const GITHUB_CONTROL_READ_ROLLOUT_PLAN_VERSION = 1 as const;

export type GitHubReadRolloutStageId =
  | "metadata-rules"
  | "contents"
  | "issues"
  | "pull-requests"
  | "checks"
  | "actions"
  | "commit-statuses";

export type GitHubReadCanaryTransport = "REST" | "GRAPHQL";

export type GitHubReadCanaryId =
  | "repository-metadata"
  | "active-branch-rules"
  | "default-branch-commit"
  | "open-issues"
  | "open-pull-requests"
  | "pull-request-reviews"
  | "pull-request-merge-state"
  | "exact-head-check-runs"
  | "workflow-runs-and-jobs"
  | "exact-head-commit-statuses";

export type GitHubReadRolloutEvidenceGate = "LEGACY_COMMIT_STATUS_REQUIRED";

export interface GitHubReadCanaryPlan {
  id: GitHubReadCanaryId;
  transport: GitHubReadCanaryTransport;
  requiredPermission: Phase2GitHubReadPermission;
}

export interface GitHubReadRolloutStage {
  id: GitHubReadRolloutStageId;
  addPermission: Phase2GitHubReadPermission;
  evidenceGate: GitHubReadRolloutEvidenceGate | null;
  canaries: readonly GitHubReadCanaryPlan[];
}

export interface GitHubReadRolloutEvidence {
  legacyCommitStatusRequired?: boolean;
}

export class GitHubReadRolloutPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubReadRolloutPlanError";
  }
}

export const phase2GitHubReadRolloutStages = [
  {
    id: "metadata-rules",
    addPermission: "metadata",
    evidenceGate: null,
    canaries: [
      { id: "repository-metadata", transport: "REST", requiredPermission: "metadata" },
      { id: "active-branch-rules", transport: "REST", requiredPermission: "metadata" },
    ],
  },
  {
    id: "contents",
    addPermission: "contents",
    evidenceGate: null,
    canaries: [{ id: "default-branch-commit", transport: "REST", requiredPermission: "contents" }],
  },
  {
    id: "issues",
    addPermission: "issues",
    evidenceGate: null,
    canaries: [{ id: "open-issues", transport: "REST", requiredPermission: "issues" }],
  },
  {
    id: "pull-requests",
    addPermission: "pull_requests",
    evidenceGate: null,
    canaries: [
      { id: "open-pull-requests", transport: "REST", requiredPermission: "pull_requests" },
      { id: "pull-request-reviews", transport: "REST", requiredPermission: "pull_requests" },
      { id: "pull-request-merge-state", transport: "GRAPHQL", requiredPermission: "pull_requests" },
    ],
  },
  {
    id: "checks",
    addPermission: "checks",
    evidenceGate: null,
    canaries: [{ id: "exact-head-check-runs", transport: "REST", requiredPermission: "checks" }],
  },
  {
    id: "actions",
    addPermission: "actions",
    evidenceGate: null,
    canaries: [{ id: "workflow-runs-and-jobs", transport: "REST", requiredPermission: "actions" }],
  },
  {
    id: "commit-statuses",
    addPermission: "statuses",
    evidenceGate: "LEGACY_COMMIT_STATUS_REQUIRED",
    canaries: [{ id: "exact-head-commit-statuses", transport: "REST", requiredPermission: "statuses" }],
  },
] as const satisfies readonly GitHubReadRolloutStage[];

const allowedReadPermissions = new Set<string>(phase2GitHubReadPermissions);
const stageById = new Map<GitHubReadRolloutStageId, GitHubReadRolloutStage>(
  phase2GitHubReadRolloutStages.map((stage) => [stage.id, stage]),
);

export function getPhase2GitHubSelectedRepositories(): readonly string[] {
  return managedProjectPolicies
    .filter((policy) => policy.enabled && policy.githubReadEnabled)
    .map((policy) => policy.repository);
}

function evidenceGateSatisfied(
  gate: GitHubReadRolloutEvidenceGate | null,
  evidence: GitHubReadRolloutEvidence,
): boolean {
  if (gate === null) return true;
  if (gate === "LEGACY_COMMIT_STATUS_REQUIRED") return evidence.legacyCommitStatusRequired === true;
  return false;
}

export function assertPhase2GitHubReadRolloutPlanIntegrity(): void {
  const repositories = getPhase2GitHubSelectedRepositories();
  if (repositories.length === 0) {
    throw new GitHubReadRolloutPlanError("GitHub App rollout requires at least one selected repository");
  }

  const repositoryNames = new Set<string>();
  for (const repository of repositories) {
    const normalized = repository.toLowerCase();
    if (repositoryNames.has(normalized)) {
      throw new GitHubReadRolloutPlanError(`Duplicate selected repository in GitHub App rollout: ${repository}`);
    }
    repositoryNames.add(normalized);
  }

  for (const excluded of explicitlyExcludedRepositories) {
    if (repositoryNames.has(excluded.toLowerCase())) {
      throw new GitHubReadRolloutPlanError(`Excluded repository entered GitHub App rollout: ${excluded}`);
    }
  }

  if (phase2GitHubReadRolloutStages[0]?.id !== "metadata-rules") {
    throw new GitHubReadRolloutPlanError("GitHub App rollout must begin with the metadata/rules canary stage");
  }

  const stageIds = new Set<string>();
  const canaryIds = new Set<string>();
  const addedPermissions = new Set<string>();
  for (const stage of phase2GitHubReadRolloutStages) {
    if (stageIds.has(stage.id)) {
      throw new GitHubReadRolloutPlanError(`Duplicate GitHub App rollout stage: ${stage.id}`);
    }
    stageIds.add(stage.id);

    if (!allowedReadPermissions.has(stage.addPermission)) {
      throw new GitHubReadRolloutPlanError(`Unsupported GitHub App rollout permission: ${stage.addPermission}`);
    }
    if (addedPermissions.has(stage.addPermission)) {
      throw new GitHubReadRolloutPlanError(`GitHub App rollout permission added more than once: ${stage.addPermission}`);
    }
    addedPermissions.add(stage.addPermission);

    if (stage.canaries.length === 0) {
      throw new GitHubReadRolloutPlanError(`GitHub App rollout stage has no canary: ${stage.id}`);
    }
    for (const canary of stage.canaries) {
      if (canary.requiredPermission !== stage.addPermission) {
        throw new GitHubReadRolloutPlanError(`GitHub App canary permission does not match its rollout stage: ${canary.id}`);
      }
      if (canaryIds.has(canary.id)) {
        throw new GitHubReadRolloutPlanError(`Duplicate GitHub App rollout canary: ${canary.id}`);
      }
      canaryIds.add(canary.id);
    }
  }
}

export function buildPhase2GitHubReadScopeForStage(
  installationId: number,
  stageId: GitHubReadRolloutStageId,
  evidence: GitHubReadRolloutEvidence = {},
): GitHubInstallationReadScope {
  assertPhase2GitHubReadRolloutPlanIntegrity();

  const target = stageById.get(stageId);
  if (!target) throw new GitHubReadRolloutPlanError(`Unknown GitHub App rollout stage: ${String(stageId)}`);
  if (!evidenceGateSatisfied(target.evidenceGate, evidence)) {
    throw new GitHubReadRolloutPlanError(`GitHub App rollout evidence gate is not satisfied: ${target.evidenceGate}`);
  }

  const permissions: Partial<Record<Phase2GitHubReadPermission, "read">> = {};
  for (const stage of phase2GitHubReadRolloutStages) {
    if (evidenceGateSatisfied(stage.evidenceGate, evidence)) {
      permissions[stage.addPermission] = "read";
    }
    if (stage.id === target.id) break;
  }

  return parseGitHubInstallationReadScope({
    installationId,
    repositories: getPhase2GitHubSelectedRepositories(),
    permissions,
  });
}

assertPhase2GitHubReadRolloutPlanIntegrity();
