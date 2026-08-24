import type { CloudflareAccessJwksFetch } from "../integrations/cloudflare/access-jwks-resolver.js";
import {
  CloudflareAccessRequestAuthenticator,
  type CloudflareAccessRequestAuthenticatorConfig,
} from "./access-request-authenticator.js";
import {
  createCloudflareGitHubAppJwtSigner,
  createCloudflareGitHubCredentialFetch,
  createCloudflareGitHubReadRuntime,
  type CloudflareGitHubRuntimeBindings,
} from "../integrations/github/cloudflare-worker-runtime.js";
import { createGitHubAppMergeSessionProvider } from "../integrations/github/app-installation-merge-session.js";
import { createGitHubPullRequestMergeWriter } from "../integrations/github/pull-request-merge-write.js";
import { D1MergeDecisionAuditStore } from "../integrations/cloudflare/d1-merge-decision-audit-store.js";
import type { D1DatabaseLike } from "../integrations/cloudflare/d1-delivery-claim-store.js";
import type { GitHubAppCredentialFetch } from "../integrations/github/app-installation-session.js";
import {
  executeMergeDecision,
  type MergeDecisionRequest,
  type MergeDecisionResult,
} from "../shared/merge-decision.js";
import { requireMergeProjectPolicy } from "../shared/project-policy.js";
import type { MergeWorkerRuntime } from "./github-merge-route.js";

export interface CloudflareMergeRuntimeBindings extends CloudflareGitHubRuntimeBindings {
  readonly CONTROL_DB: D1DatabaseLike;
}

export interface CloudflareMergeProductionBindings extends CloudflareMergeRuntimeBindings {
  readonly CONTROL_MERGE_ACCESS_ISSUER: string;
  readonly CONTROL_MERGE_ACCESS_AUDIENCE: string;
}

export interface CloudflareMergeRuntimeOptions {
  readonly bindings: CloudflareMergeRuntimeBindings;
  readonly access: CloudflareAccessRequestAuthenticatorConfig;
  readonly githubFetch?: GitHubAppCredentialFetch;
  readonly accessFetch?: CloudflareAccessJwksFetch;
  readonly clock?: () => Date;
}

function normalizedNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Merge runtime clock is invalid");
  }
  return value.toISOString();
}

function nonEmptyAccessBinding(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    /[\r\n]/.test(value)
  ) {
    return null;
  }
  return value;
}

function accessIssuerBinding(value: unknown): string | null {
  const raw = nonEmptyAccessBinding(value);
  if (raw === null) return null;

  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/"
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function createCloudflareMergeRuntime(
  options: CloudflareMergeRuntimeOptions,
): MergeWorkerRuntime {
  const clock = options.clock ?? (() => new Date());
  const readRuntime = createCloudflareGitHubReadRuntime({
    bindings: options.bindings,
    ...(options.githubFetch === undefined ? {} : { fetchRequest: options.githubFetch }),
  });

  const githubFetch = createCloudflareGitHubCredentialFetch(options.githubFetch);
  const signer = createCloudflareGitHubAppJwtSigner(options.bindings.GITHUB_APP_PRIVATE_KEY_PEM);
  const writeSessionProvider = createGitHubAppMergeSessionProvider(
    {
      identity: { clientId: readRuntime.clientId },
      signer,
      fetchRequest: githubFetch,
    },
    readRuntime.installationId,
  );
  const writer = createGitHubPullRequestMergeWriter(writeSessionProvider);
  const auditStore = new D1MergeDecisionAuditStore(options.bindings.CONTROL_DB, clock);
  const authenticator = new CloudflareAccessRequestAuthenticator(options.access, {
    ...(options.accessFetch === undefined ? {} : { fetch: options.accessFetch }),
    clock,
  });

  return {
    authenticator,

    async executeDecision(request: MergeDecisionRequest): Promise<MergeDecisionResult> {
      const project = requireMergeProjectPolicy(request.repository);
      const observedAt = normalizedNow(clock);
      const context = readRuntime.createRepositoryNeedsChangesReadContext(project.repository, observedAt);

      return executeMergeDecision(
        {
          ...request,
          repository: project.repository,
        },
        {
          provider: context.provider,
          branchPolicyReader: context.branchPolicyReader,
          writer,
          auditStore,
          clock: () => new Date(observedAt),
        },
      );
    },
  };
}

export function resolveCloudflareMergeRuntime(
  bindings: CloudflareMergeProductionBindings,
): MergeWorkerRuntime | null {
  const issuer = accessIssuerBinding(bindings.CONTROL_MERGE_ACCESS_ISSUER);
  const audience = nonEmptyAccessBinding(bindings.CONTROL_MERGE_ACCESS_AUDIENCE);
  if (issuer === null || audience === null) return null;

  try {
    return createCloudflareMergeRuntime({
      bindings,
      access: { issuer, audience },
    });
  } catch {
    return null;
  }
}
