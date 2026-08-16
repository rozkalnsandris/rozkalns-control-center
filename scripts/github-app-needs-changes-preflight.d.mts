export interface GitHubAppNeedsChangesPreflightContract {
  readonly apiOrigin: string;
  readonly apiVersion: string;
  readonly accept: string;
  readonly userAgent: string;
  readonly appId: number;
  readonly appName: string;
  readonly clientId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly managedRepositories: readonly string[];
  readonly excludedRepository: string;
  readonly currentPermissions: Readonly<Record<string, string>>;
  readonly proposedPermissionDelta: string;
}

export const PREFLIGHT_CONTRACT: GitHubAppNeedsChangesPreflightContract;

export class GitHubAppNeedsChangesPreflightError extends Error {
  readonly code: string;
}

export function createGitHubAppJwt(privateKeyPem: string, nowMs?: number): string;

export interface ObserveGitHubAppStateOptions {
  readonly fetchImpl?: typeof fetch;
  readonly privateKeyPem?: string;
  readonly nowMs?: number;
}

export interface ObservedGitHubAppState {
  readonly appId: number;
  readonly clientId: string;
  readonly installationId: number;
  readonly repositorySelection: "selected";
  readonly repositories: readonly string[];
  readonly excludedRepository: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly proposedPermissionDelta: string;
  readonly remoteConfigurationMutation: false;
  readonly ephemeralReadCredentialIssued: true;
}

export function observeGitHubAppState(options?: ObserveGitHubAppStateOptions): Promise<ObservedGitHubAppState>;
export function assertLocalOwnerPreconditions(expectedSha: string): void;
export function main(argv?: string[]): Promise<void>;
