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
    async sign(signingInput: string): Promise<string> {
      try {
        return signRsaSha256("RSA-SHA256", Buffer.from(signingInput), privateKeyPem).toString("base64url");
      } catch {
        throw new CloudflareGitHubRuntimeError("SIGNING_FAILED");
      }
    },
  };
}

function createBaseScope(installationId: number, repository: string): GitHubInstallationReadScope {
  const rolloutScope = buildPhase2GitHubReadScopeForStage(installationId, "actions");
  return parseGitHubInstallationReadScope({
    installationId,
    repositories: [repository],
    permissions: rolloutScope.permissions,
  });
}

function repositoryFromScope(scope: GitHubInstallationReadScope, repositoryInput: string): string {
  const repository = repositoryInput.trim();
  if (repository === "" || /[\r\n]/.test(repository)) {
    throw new CloudflareGitHubRuntimeError("INVALID_REPOSITORY");
  }
  if (!scope.repositories.includes(repository)) {
    throw new CloudflareGitHubRuntimeError("INVALID_REPOSITORY");
  }
  return repository;
}

export function createCloudflareGitHubReadRuntime(
  options: CloudflareGitHubReadRuntimeOptions,
): CloudflareGitHubReadRuntime {
  const clientId = nonEmptyBinding(options.bindings.GITHUB_APP_CLIENT_ID);
  const installationId = installationIdBinding(options.bindings.GITHUB_APP_INSTALLATION_ID);
  const privateKeyPem = privateKeyBinding(options.bindings.GITHUB_APP_PRIVATE_KEY_PEM);
  const fetchRequest = options.fetchRequest ?? fetch;
  const signer = createCloudflareGitHubAppJwtSigner(privateKeyPem);

  const restSessionProvider = createGitHubAppInstallationSessionProvider({ clientId, signer, fetchRequest });
  const graphqlSessionProvider = createGitHubAppInstallationGraphqlSessionProvider({ clientId, signer, fetchRequest });
  const restTransport = createGitHubCredentialDiagnosticRestTransport(restSessionProvider);
  const graphqlMergeStateTransport = createGitHubCredentialDiagnosticGraphqlTransport(graphqlSessionProvider);

  function createRepositoryReadContext(
    repositoryInput: string,
    observedAtInput: string,
  ): CloudflareGitHubRepositoryReadContext {
    const observedAt = observedAtValue(observedAtInput);
    const repository = nonEmptyBinding(repositoryInput);
    const scope = createBaseScope(installationId, repository);
    repositoryFromScope(scope, repository);

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
    const branchPolicyReader: BranchPolicyEvidenceReader = {
      async readBranchPolicyEvidence(repositoryInputInner, branch, observedAtInner) {
        if (repositoryInputInner !== repository || observedAtInner !== observedAt) {
          throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
        }
        return activeBranchRulesReader.readPartialBranchPolicyEvidence(repository, branch);
      },
    };

    return { scope, provider, activeBranchRulesReader, branchPolicyReader };
  }

  function createRepositoryNeedsChangesReadContext(
    repositoryInput: string,
    observedAtInput: string,
  ): CloudflareGitHubNeedsChangesReadContext {
    const observedAt = observedAtValue(observedAtInput);
    const repository = nonEmptyBinding(repositoryInput);
    const scope = createBaseScope(installationId, repository);
    repositoryFromScope(scope, repository);

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
    const classicScope = parseGitHubInstallationReadScope({
      installationId,
      repositories: [repository],
      permissions: { metadata: "read", administration: "read" },
    });
    const branchMetadataScope = parseGitHubInstallationReadScope({
      installationId,
      repositories: [repository],
      permissions: { metadata: "read", contents: "read" },
    });
    const classicBranchProtectionReader = createGitHubClassicBranchProtectionReader({
      scope: classicScope,
      absenceScope: branchMetadataScope,
      observedAt,
      restTransport,
    });
    const branchPolicyReader: BranchPolicyEvidenceReader = {
      async readBranchPolicyEvidence(repositoryInputInner, branch, observedAtInner) {
        if (repositoryInputInner !== repository || observedAtInner !== observedAt) {
          throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
        }
        const [active, classic] = await Promise.all([
          activeBranchRulesReader.readActiveBranchRules(repository, branch),
          classicBranchProtectionReader.readClassicBranchProtection(repository, branch),
        ]);
        if (classic.classicProtectionState === "ABSENT" && active.activeRuleCount !== 0) {
          throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
        }
        if (classic.classicProtectionState === "ABSENT_RULESET_PROTECTED" && active.activeRuleCount === 0) {
          throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
        }
        return combineBranchPolicyObservations(
          [active, classic],
          repository,
          branch,
          observedAt,
        );
      },
    };

    return {
      scope,
      classicScope,
      branchMetadataScope,
      provider,
      activeBranchRulesReader,
      classicBranchProtectionReader,
      branchPolicyReader,
    };
  }

  return {
    clientId,
    installationId,
    createRepositoryReadContext,
    createRepositoryNeedsChangesReadContext,
  };
}
