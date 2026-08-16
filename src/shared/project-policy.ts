export type ProductionAdapter = "none" | "rpi5";

export interface ManagedProjectPolicy {
  id: string;
  displayName: string;
  repository: string;
  enabled: boolean;
  githubReadEnabled: boolean;
  canRequestChanges: boolean;
  productionAdapter: ProductionAdapter;
}

export const managedProjectPolicies = [
  {
    id: "hermes-tech",
    displayName: "Hermes Tech",
    repository: "rozkalnsandris/hermes-tech",
    enabled: true,
    githubReadEnabled: true,
    canRequestChanges: false,
    productionAdapter: "rpi5",
  },
  {
    id: "hermes-deals",
    displayName: "Hermes Deals",
    repository: "rozkalnsandris/hermes-deals",
    enabled: true,
    githubReadEnabled: true,
    canRequestChanges: false,
    productionAdapter: "rpi5",
  },
  {
    id: "rozkalns-cv",
    displayName: "Rozkalns CV",
    repository: "rozkalnsandris/rozkalns-cv",
    enabled: true,
    githubReadEnabled: true,
    canRequestChanges: false,
    productionAdapter: "rpi5",
  },
  {
    id: "rpi5-main",
    displayName: "RPi5 Main",
    repository: "rozkalnsandris/RPi5_main",
    enabled: true,
    githubReadEnabled: true,
    canRequestChanges: false,
    productionAdapter: "rpi5",
  },
  {
    id: "ops-workflows",
    displayName: "Ops Workflows",
    repository: "rozkalnsandris/ops-workflows",
    enabled: true,
    githubReadEnabled: true,
    canRequestChanges: false,
    productionAdapter: "none",
  },
  {
    id: "profile",
    displayName: "GitHub Profile",
    repository: "rozkalnsandris/rozkalnsandris",
    enabled: true,
    githubReadEnabled: true,
    canRequestChanges: false,
    productionAdapter: "none",
  },
] as const satisfies readonly ManagedProjectPolicy[];

export const explicitlyExcludedRepositories = ["rozkalnsandris/hermes-email-skill"] as const;

function normalizeRepository(repository: string) {
  return repository.trim().toLowerCase();
}

const policyByRepository = new Map(
  managedProjectPolicies.map((policy) => [normalizeRepository(policy.repository), policy] as const),
);

const excludedRepositories = new Set(explicitlyExcludedRepositories.map(normalizeRepository));

export class RepositoryNotAllowedError extends Error {
  constructor(repository: string) {
    super(`Repository is not enabled for Rozkalns Control reads: ${repository}`);
    this.name = "RepositoryNotAllowedError";
  }
}

export class RepositoryNeedsChangesNotAllowedError extends Error {
  constructor(repository: string) {
    super(`Repository is not enabled for Rozkalns Control Needs changes actions: ${repository}`);
    this.name = "RepositoryNeedsChangesNotAllowedError";
  }
}

export function isExplicitlyExcludedRepository(repository: string) {
  return excludedRepositories.has(normalizeRepository(repository));
}

export function resolveManagedProjectPolicy(repository: string): ManagedProjectPolicy | null {
  const policy = policyByRepository.get(normalizeRepository(repository));
  if (!policy || !policy.enabled || !policy.githubReadEnabled) return null;
  return policy;
}

export function requireManagedProjectPolicy(repository: string): ManagedProjectPolicy {
  const policy = resolveManagedProjectPolicy(repository);
  if (!policy) throw new RepositoryNotAllowedError(repository);
  return policy;
}

export function resolveNeedsChangesProjectPolicy(repository: string): ManagedProjectPolicy | null {
  const policy = resolveManagedProjectPolicy(repository);
  if (!policy || policy.canRequestChanges !== true) return null;
  return policy;
}

export function requireNeedsChangesProjectPolicy(repository: string): ManagedProjectPolicy {
  const policy = resolveNeedsChangesProjectPolicy(repository);
  if (!policy) throw new RepositoryNeedsChangesNotAllowedError(repository);
  return policy;
}
