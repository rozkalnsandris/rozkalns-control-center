import type { CloudflareAccessJwksFetch } from "../integrations/cloudflare/access-jwks-resolver.js";
import { D1LaterDeferralStore } from "../integrations/cloudflare/d1-later-deferral-store.js";
import type { D1DatabaseLike } from "../integrations/cloudflare/d1-delivery-claim-store.js";
import { readCloudflareGitHubDashboardSnapshot } from "../integrations/github/cloudflare-dashboard-runtime.js";
import type { GitHubAppCredentialFetch } from "../integrations/github/app-installation-session.js";
import type { CloudflareGitHubRuntimeBindings } from "../integrations/github/cloudflare-worker-runtime.js";
import {
  executeLaterAction,
  type LaterActionRequest,
  type LaterActionResult,
} from "../shared/later-action.js";
import { requireLaterProjectPolicy } from "../shared/project-policy.js";
import {
  CloudflareAccessRequestAuthenticator,
  type CloudflareAccessRequestAuthenticatorConfig,
} from "./access-request-authenticator.js";
import type { LaterWorkerRuntime } from "./github-later-route.js";

export interface CloudflareLaterRuntimeBindings extends CloudflareGitHubRuntimeBindings {
  readonly CONTROL_DB: D1DatabaseLike;
}

export interface CloudflareLaterProductionBindings extends CloudflareLaterRuntimeBindings {
  readonly CONTROL_LATER_ACCESS_ISSUER: string;
  readonly CONTROL_LATER_ACCESS_AUDIENCE: string;
}

export interface CloudflareLaterRuntimeOptions {
  readonly bindings: CloudflareLaterRuntimeBindings;
  readonly access: CloudflareAccessRequestAuthenticatorConfig;
  readonly githubFetch?: GitHubAppCredentialFetch;
  readonly accessFetch?: CloudflareAccessJwksFetch;
  readonly clock?: () => Date;
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

export function createCloudflareLaterRuntime(
  options: CloudflareLaterRuntimeOptions,
): LaterWorkerRuntime {
  const clock = options.clock ?? (() => new Date());
  const authenticator = new CloudflareAccessRequestAuthenticator(options.access, {
    ...(options.accessFetch === undefined ? {} : { fetch: options.accessFetch }),
    clock,
  });
  const store = new D1LaterDeferralStore(options.bindings.CONTROL_DB);

  return {
    authenticator,

    async executeDecision(
      request: Omit<LaterActionRequest, "projectId">,
    ): Promise<LaterActionResult> {
      const project = requireLaterProjectPolicy(request.repository);
      return executeLaterAction(
        {
          ...request,
          repository: project.repository,
          projectId: project.id,
        },
        {
          readDashboard: (observedAt) =>
            readCloudflareGitHubDashboardSnapshot({
              bindings: options.bindings,
              observedAt,
              ...(options.githubFetch === undefined
                ? {}
                : { fetchRequest: options.githubFetch }),
            }),
          store,
          clock,
        },
      );
    },
  };
}

export function resolveCloudflareLaterRuntime(
  bindings: CloudflareLaterProductionBindings,
): LaterWorkerRuntime | null {
  const issuer = accessIssuerBinding(bindings.CONTROL_LATER_ACCESS_ISSUER);
  const audience = nonEmptyAccessBinding(bindings.CONTROL_LATER_ACCESS_AUDIENCE);
  if (issuer === null || audience === null) return null;

  try {
    return createCloudflareLaterRuntime({
      bindings,
      access: { issuer, audience },
    });
  } catch {
    return null;
  }
}
