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
import {
  createGitHubAppPullRequestWriteSessionProvider,
} from "../integrations/github/app-installation-review-session.js";
import {
  createGitHubPullRequestReviewWriter,
} from "../integrations/github/pull-request-review-write.js";
import {
  D1NeedsChangesDecisionAuditStore,
} from "../integrations/cloudflare/d1-needs-changes-audit-store.js";
import type { D1DatabaseLike } from "../integrations/cloudflare/d1-delivery-claim-store.js";
import type { GitHubAppCredentialFetch } from "../integrations/github/app-installation-session.js";
import {
  executeNeedsChangesDecision,
  type NeedsChangesDecisionRequest,
  type NeedsChangesDecisionResult,
} from "../shared/needs-changes-decision.js";
import { requireNeedsChangesProjectPolicy } from "../shared/project-policy.js";
import type { NeedsChangesWorkerRuntime } from "./github-needs-changes-route.js";

export interface CloudflareNeedsChangesRuntimeBindings extends CloudflareGitHubRuntimeBindings {
  readonly CONTROL_DB: D1DatabaseLike;
}

export interface CloudflareNeedsChangesRuntimeOptions {
  readonly bindings: CloudflareNeedsChangesRuntimeBindings;
  readonly access: CloudflareAccessRequestAuthenticatorConfig;
  readonly githubFetch?: GitHubAppCredentialFetch;
  readonly accessFetch?: CloudflareAccessJwksFetch;
  readonly clock?: () => Date;
}

function normalizedNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Needs changes runtime clock is invalid");
  }
  return value.toISOString();
}

export function createCloudflareNeedsChangesRuntime(
  options: CloudflareNeedsChangesRuntimeOptions,
): NeedsChangesWorkerRuntime {
  const clock = options.clock ?? (() => new Date());
  const readRuntime = createCloudflareGitHubReadRuntime({
    bindings: options.bindings,
    ...(options.githubFetch === undefined ? {} : { fetchRequest: options.githubFetch }),
  });

  const githubFetch = createCloudflareGitHubCredentialFetch(options.githubFetch);
  const signer = createCloudflareGitHubAppJwtSigner(options.bindings.GITHUB_APP_PRIVATE_KEY_PEM);
  const writeSessionProvider = createGitHubAppPullRequestWriteSessionProvider(
    {
      identity: { clientId: readRuntime.clientId },
      signer,
      fetchRequest: githubFetch,
    },
    readRuntime.installationId,
  );
  const writer = createGitHubPullRequestReviewWriter(writeSessionProvider);
  const auditStore = new D1NeedsChangesDecisionAuditStore(options.bindings.CONTROL_DB, clock);
  const authenticator = new CloudflareAccessRequestAuthenticator(options.access, {
    ...(options.accessFetch === undefined ? {} : { fetch: options.accessFetch }),
    clock,
  });

  return {
    authenticator,

    async executeDecision(request: NeedsChangesDecisionRequest): Promise<NeedsChangesDecisionResult> {
      const project = requireNeedsChangesProjectPolicy(request.repository);
      const observedAt = normalizedNow(clock);
      const context = readRuntime.createRepositoryReadContext(project.repository, observedAt);

      return executeNeedsChangesDecision(
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
