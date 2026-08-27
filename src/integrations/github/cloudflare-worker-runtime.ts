import { sign as signRsaSha256 } from "node:crypto";

import type { BranchPolicyEvidenceReader } from "../../shared/authoritative-reconciliation.js";
import { combineBranchPolicyObservations } from "../../shared/github-policy-evidence.js";
import {
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
} from "./app-installation-read-contract.js";
import {
  createGitHubAppInstallationGraphqlSessionProvider,
  createGitHubAppInstallationSessionProvider,
  type GitHubAppCredentialFetch,
  type GitHubAppJwtSigner,
} from "./app-installation-session.js";
import { buildPhase2GitHubReadScopeForStage } from "./app-read-rollout-plan.js";
import {
  createGitHubActiveBranchRulesReader,
  type GitHubActiveBranchRulesReader,
} from "./active-branch-rules-reader.js";
import {
  createGitHubAuthoritativeReadProvider,
  type GitHubAuthoritativeReadProvider,
} from "./authoritative-read-provider.js";
import {
  createGitHubClassicBranchProtectionReader,
  type GitHubClassicBranchProtectionReader,
} from "./classic-branch-protection-reader.js";
import {
  createGitHubCredentialDiagnosticGraphqlTransport,
  createGitHubCredentialDiagnosticRestTransport,
} from "./credential-stage-diagnostics.js";

export const GITHUB_APP_PRIVATE_KEY_SECRET_NAME = "GITHUB_APP_PRIVATE_KEY_PEM" as const;
export const GITHUB_APP_CLIENT_ID_BINDING_NAME = "GITHUB_APP_CLIENT_ID" as const;
export const GITHUB_APP_INSTALLATION_ID_BINDING_NAME = "GITHUB_APP_INSTALLATION_ID" as const;
export const GITHUB_API_USER_AGENT = "Rozkalns-Control" as const;

export interface CloudflareGitHubRuntimeBindings {
  readonly GITHUB_APP_PRIVATE_KEY_PEM: string;
  readonly GITHUB_APP_CLIENT_ID: string;
  readonly GITHUB_APP_INSTALLATION_ID: string;
}

export type CloudflareGitHubRuntimeFailureCode =
  | "INVALID_BINDING"
  | "INVALID_REPOSITORY"
  | "INVALID_CONTEXT"
  | "SIGNING_FAILED";

const failureMessages: Readonly<Record<CloudflareGitHubRuntimeFailureCode, string>> = {
  INVALID_BINDING: "Cloudflare GitHub runtime binding failed validation",
  INVALID_REPOSITORY: "Cloudflare GitHub runtime repository is not selected for read access",
  INVALID_CONTEXT: "Cloudflare GitHub runtime reconciliation context is inconsistent",
  SIGNING_FAILED: "Cloudflare GitHub runtime signing failed",
};

export class CloudflareGitHubRuntimeError extends Error {
  readonly code: CloudflareGitHubRuntimeFailureCode;

  constructor(code: CloudflareGitHubRuntimeFailureCode) {
    super(failureMessages[code]);
    this.name = "CloudflareGitHubRuntimeError";
    this.code = code;
  }
}

export interface CloudflareGitHubRepositoryReadContext {
  readonly scope: GitHubInstallationReadScope;
  readonly provider: GitHubAuthoritativeReadProvider;
  readonly activeBranchRulesReader: GitHubActiveBranchRulesReader;
  readonly branchPolicyReader: BranchPolicyEvidenceReader;
}

export interface CloudflareGitHubNeedsChangesReadContext extends CloudflareGitHubRepositoryReadContext {
  readonly classicScope: GitHubInstallationReadScope;
  readonly branchMetadataScope: GitHubInstallationReadScope;
  readonly classicBranchProtectionReader: GitHubClassicBranchProtectionReader;
}

export interface CloudflareGitHubReadRuntime {
  readonly clientId: string;
  readonly installationId: number;
  createRepositoryReadContext(repository: string, observedAt: string): CloudflareGitHubRepositoryReadContext;
  createRepositoryNeedsChangesReadContext(repository: string, observedAt: string): CloudflareGitHubNeedsChangesReadContext;
}

export interface CloudflareGitHubReadRuntimeOptions {
  readonly bindings: CloudflareGitHubRuntimeBindings;
  readonly fetchRequest?: GitHubAppCredentialFetch;
}

function invalidBinding(): never {
  throw new CloudflareGitHubRuntimeError("INVALID_BINDING");
}

function nonEmptyBinding(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\r\n]/.test(value)) {
    return invalidBinding();
  }
  return value;
}

function privateKeyBinding(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return invalidBinding();
  return value.trim();
}

function installationIdBinding(value: unknown): number {
  const raw = nonEmptyBinding(value);
  if (!/^[1-9][0-9]*$/.test(raw)) return invalidBinding();
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return invalidBinding();
  return parsed;
}

function observedAtValue(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
  }
  return value;
}

export function createCloudflareGitHubAppJwtSigner(privateKeyPemInput: string): GitHubAppJwtSigner {
  const privateKeyPem = privateKeyBinding(privateKeyPemInput);

  return {
    async signRs256(signingInput: Uint8Array): Promise<Uint8Array> {
      try {
        const signature = signRsaSha256("sha256", signingInput, privateKeyPem);
        if (signature.byteLength === 0) throw new Error("empty signature");
        return new Uint8Array(signature);
      } catch {
        throw new CloudflareGitHubRuntimeError("SIGNING_FAILED");
      }
    },
  };
}

export function createCloudflareGitHubCredentialFetch(
  fetchImplementation: GitHubAppCredentialFetch = fetch,
): GitHubAppCredentialFetch {
  return (request) => {
    request.headers.set("User-Agent", GITHUB_API_USER_AGENT);
    return fetchImplementation(request);
  };
}

function selectedRepository(scope: GitHubInstallationReadScope, repositoryInput: string): string {
  if (typeof repositoryInput !== "string" || repositoryInput.trim() === "") {
    throw new CloudflareGitHubRuntimeError("INVALID_REPOSITORY");
  }
  const normalized = repositoryInput.trim().toLowerCase();
  const repository = scope.repositories.find((candidate) => candidate.toLowerCase() === normalized);
  if (!repository) throw new CloudflareGitHubRuntimeError("INVALID_REPOSITORY");
  return repository;
}

function sessionCacheKey(scope: GitHubInstallationReadScope, observedAt: string): string {
  const permissions = Object.entries(scope.permissions).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([scope.installationId, [...scope.repositories].sort(), permissions, observedAt]);
}

export function memoizeGitHubInstallationSessionProvider<T>(
  acquire: (scope: GitHubInstallationReadScope, observedAt: string) => Promise<T>,
): (scope: GitHubInstallationReadScope, observedAt: string) => Promise<T> {
  const sessions = new Map<string, Promise<T>>();
  return (scope, observedAt) => {
    const key = sessionCacheKey(scope, observedAt);
    const existing = sessions.get(key);
    if (existing) return existing;

    const pending = acquire(scope, observedAt).catch((error: unknown) => {
      sessions.delete(key);
      throw error;
    });
    sessions.set(key, pending);
    return pending;
  };
}

export function createCloudflareGitHubReadRuntime(
  options: CloudflareGitHubReadRuntimeOptions,
): CloudflareGitHubReadRuntime {
  const clientId = nonEmptyBinding(options.bindings.GITHUB_APP_CLIENT_ID);
  const installationId = installationIdBinding(options.bindings.GITHUB_APP_INSTALLATION_ID);
  const signer = createCloudflareGitHubAppJwtSigner(options.bindings.GITHUB_APP_PRIVATE_KEY_PEM);
  const fetchRequest = createCloudflareGitHubCredentialFetch(options.fetchRequest);

  const dependencies = {
    identity: { clientId },
    signer,
    fetchRequest,
  };
  const restSessionProvider = memoizeGitHubInstallationSessionProvider(
    createGitHubAppInstallationSessionProvider(dependencies),
  );
  const graphqlSessionProvider = memoizeGitHubInstallationSessionProvider(
    createGitHubAppInstallationGraphqlSessionProvider(dependencies),
  );
  const restTransport = createGitHubCredentialDiagnosticRestTransport(restSessionProvider);
  const graphqlMergeStateTransport = createGitHubCredentialDiagnosticGraphqlTransport(graphqlSessionProvider);

  const approvedRolloutScope = buildPhase2GitHubReadScopeForStage(installationId, "actions");
  const needsChangesRolloutScope = buildPhase2GitHubReadScopeForStage(
    installationId,
    "commit-statuses",
    { legacyCommitStatusRequired: true },
  );

  function baseContext(
    repositoryInput: string,
    observedAtInput: string,
    rolloutScope: GitHubInstallationReadScope = approvedRolloutScope,
  ): {
    repository: string;
    observedAt: string;
    scope: GitHubInstallationReadScope;
    provider: GitHubAuthoritativeReadProvider;
    activeBranchRulesReader: GitHubActiveBranchRulesReader;
  } {
    const repository = selectedRepository(rolloutScope, repositoryInput);
    const observedAt = observedAtValue(observedAtInput);
    const scope = parseGitHubInstallationReadScope({
      installationId,
      repositories: [repository],
      permissions: rolloutScope.permissions,
    });
    const provider = createGitHubAuthoritativeReadProvider({
      scope,
      observedAt,
      restTransport,
      graphqlMergeStateTransport,
    });
    const activeBranchRulesReader = createGitHubActiveBranchRulesReader({
      scope,
      observedAt,
      restTransport,
    });
    return { repository, observedAt, scope, provider, activeBranchRulesReader };
  }

  function assertContext(repositoryInput: string, repository: string, observedAtInput: string, observedAt: string): void {
    if (repositoryInput.toLowerCase() !== repository.toLowerCase() || observedAtInput !== observedAt) {
      throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
    }
  }

  return {
    clientId,
    installationId,

    createRepositoryReadContext(repositoryInput: string, observedAtInput: string): CloudflareGitHubRepositoryReadContext {
      const base = baseContext(repositoryInput, observedAtInput);
      const branchPolicyReader: BranchPolicyEvidenceReader = {
        async readBranchPolicyEvidence(repositoryInputInner, branch, observedAtInner) {
          assertContext(repositoryInputInner, base.repository, observedAtInner, base.observedAt);
          return base.activeBranchRulesReader.readPartialBranchPolicyEvidence(base.repository, branch);
        },
      };

      return {
        scope: base.scope,
        provider: base.provider,
        activeBranchRulesReader: base.activeBranchRulesReader,
        branchPolicyReader,
      };
    },

    createRepositoryNeedsChangesReadContext(
      repositoryInput: string,
      observedAtInput: string,
    ): CloudflareGitHubNeedsChangesReadContext {
      const base = baseContext(repositoryInput, observedAtInput, needsChangesRolloutScope);
      const classicScope = parseGitHubInstallationReadScope({
        installationId,
        repositories: [base.repository],
        permissions: { metadata: "read", administration: "read" },
      });
      const branchMetadataScope = parseGitHubInstallationReadScope({
        installationId,
        repositories: [base.repository],
        permissions: { metadata: "read", contents: "read" },
      });
      const classicBranchProtectionReader = createGitHubClassicBranchProtectionReader({
        scope: classicScope,
        absenceScope: branchMetadataScope,
        observedAt: base.observedAt,
        restTransport,
      });
      const branchPolicyReader: BranchPolicyEvidenceReader = {
        async readBranchPolicyEvidence(repositoryInputInner, branch, observedAtInner) {
          assertContext(repositoryInputInner, base.repository, observedAtInner, base.observedAt);
          const [active, classic] = await Promise.all([
            base.activeBranchRulesReader.readActiveBranchRules(base.repository, branch),
            classicBranchProtectionReader.readClassicBranchProtection(base.repository, branch),
          ]);
          if (classic.classicProtectionState === "ABSENT" && active.activeRuleCount !== 0) {
            throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
          }
          if (classic.classicProtectionState === "ABSENT_RULESET_PROTECTED" && active.activeRuleCount === 0) {
            throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
          }
          return combineBranchPolicyObservations(
            [active, classic],
            base.repository,
            branch,
            base.observedAt,
          );
        },
      };

      return {
        scope: base.scope,
        classicScope,
        branchMetadataScope,
        provider: base.provider,
        activeBranchRulesReader: base.activeBranchRulesReader,
        classicBranchProtectionReader,
        branchPolicyReader,
      };
    },
  };
}
