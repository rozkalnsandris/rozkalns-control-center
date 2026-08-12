import { sign as signRsaSha256 } from "node:crypto";

import type { BranchPolicyEvidenceReader } from "../../shared/authoritative-reconciliation.js";
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
import { createGitHubGraphqlMergeStateTransport } from "./graphql-merge-state-transport.js";
import { createGitHubRestReadTransport } from "./rest-read-transport.js";

export const GITHUB_APP_PRIVATE_KEY_SECRET_NAME = "GITHUB_APP_PRIVATE_KEY_PEM" as const;
export const GITHUB_APP_CLIENT_ID_BINDING_NAME = "GITHUB_APP_CLIENT_ID" as const;
export const GITHUB_APP_INSTALLATION_ID_BINDING_NAME = "GITHUB_APP_INSTALLATION_ID" as const;

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

export interface CloudflareGitHubReadRuntime {
  readonly clientId: string;
  readonly installationId: number;
  createRepositoryReadContext(repository: string, observedAt: string): CloudflareGitHubRepositoryReadContext;
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

function selectedRepository(scope: GitHubInstallationReadScope, repositoryInput: string): string {
  if (typeof repositoryInput !== "string" || repositoryInput.trim() === "") {
    throw new CloudflareGitHubRuntimeError("INVALID_REPOSITORY");
  }
  const normalized = repositoryInput.trim().toLowerCase();
  const repository = scope.repositories.find((candidate) => candidate.toLowerCase() === normalized);
  if (!repository) throw new CloudflareGitHubRuntimeError("INVALID_REPOSITORY");
  return repository;
}

export function createCloudflareGitHubReadRuntime(
  options: CloudflareGitHubReadRuntimeOptions,
): CloudflareGitHubReadRuntime {
  const clientId = nonEmptyBinding(options.bindings.GITHUB_APP_CLIENT_ID);
  const installationId = installationIdBinding(options.bindings.GITHUB_APP_INSTALLATION_ID);
  const signer = createCloudflareGitHubAppJwtSigner(options.bindings.GITHUB_APP_PRIVATE_KEY_PEM);
  const fetchRequest = options.fetchRequest ?? fetch;

  const dependencies = {
    identity: { clientId },
    signer,
    fetchRequest,
  };
  const restTransport = createGitHubRestReadTransport(createGitHubAppInstallationSessionProvider(dependencies));
  const graphqlMergeStateTransport = createGitHubGraphqlMergeStateTransport(
    createGitHubAppInstallationGraphqlSessionProvider(dependencies),
  );

  const approvedRolloutScope = buildPhase2GitHubReadScopeForStage(installationId, "actions");

  return {
    clientId,
    installationId,

    createRepositoryReadContext(repositoryInput: string, observedAtInput: string): CloudflareGitHubRepositoryReadContext {
      const repository = selectedRepository(approvedRolloutScope, repositoryInput);
      const observedAt = observedAtValue(observedAtInput);
      const scope = parseGitHubInstallationReadScope({
        installationId,
        repositories: [repository],
        permissions: approvedRolloutScope.permissions,
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
      const branchPolicyReader: BranchPolicyEvidenceReader = {
        async readBranchPolicyEvidence(repositoryInputInner, branch, observedAtInner) {
          if (
            repositoryInputInner.toLowerCase() !== repository.toLowerCase() ||
            observedAtInner !== observedAt
          ) {
            throw new CloudflareGitHubRuntimeError("INVALID_CONTEXT");
          }
          return activeBranchRulesReader.readPartialBranchPolicyEvidence(repository, branch);
        },
      };

      return {
        scope,
        provider,
        activeBranchRulesReader,
        branchPolicyReader,
      };
    },
  };
}
