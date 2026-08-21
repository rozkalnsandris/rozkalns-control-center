import type { ContinuationPlanResult } from "../../shared/continuation-plan.js";
import type { GitHubAppCredentialFetch } from "../github/app-installation-session.js";
import {
  createCloudflareGitHubReadRuntime,
  type CloudflareGitHubRuntimeBindings,
} from "../github/cloudflare-worker-runtime.js";
import { planContinuationNextTaskTransition } from "./continuation-next-task-transition.js";
import { reselectContinuationAfterMerge } from "./continuation-post-merge-reselection.js";
import type { ContinuationPostMergeTransitionProposal } from "./continuation-post-merge-transition.js";
import {
  recoverAndCoordinateAuthoritativeContinuation,
  type ContinuationRecoveryCoordinationResult,
} from "./continuation-recovery-coordinator.js";
import {
  D1ContinuationCampaignReader,
  type ContinuationCampaignRecoveryIdentity,
} from "./d1-continuation-campaign-reader.js";
import {
  D1ContinuationNextTaskStore,
  type ContinuationNextTaskPersistenceResult,
} from "./d1-continuation-next-task-store.js";
import type { D1DatabaseLike } from "./d1-delivery-claim-store.js";

export const CONTROL_CONTINUATION_RUNTIME_ENABLED_BINDING =
  "CONTROL_CONTINUATION_RUNTIME_ENABLED" as const;

export interface CloudflareContinuationRuntimeBindings {
  readonly CONTROL_CONTINUATION_RUNTIME_ENABLED?: string;
  readonly CONTROL_DB?: D1DatabaseLike;
  readonly GITHUB_APP_PRIVATE_KEY_PEM?: string;
  readonly GITHUB_APP_CLIENT_ID?: string;
  readonly GITHUB_APP_INSTALLATION_ID?: string;
}

export interface CloudflareContinuationRuntimeOptions {
  readonly now?: () => string;
  readonly fetchRequest?: GitHubAppCredentialFetch;
}

type NonReadyContinuationPlan = Exclude<ContinuationPlanResult, { readonly kind: "READY" }>;
type ReadyContinuationPlan = Extract<ContinuationPlanResult, { readonly kind: "READY" }>;

export type ContinuationReselectionReservationResult =
  | { readonly kind: "NO_RESERVATION"; readonly plan: NonReadyContinuationPlan }
  | {
      readonly kind: "RESERVED";
      readonly plan: ReadyContinuationPlan;
      readonly persistence: ContinuationNextTaskPersistenceResult;
    };

export interface CloudflareContinuationRuntime {
  recoverAndCoordinate(
    identity: ContinuationCampaignRecoveryIdentity,
  ): Promise<ContinuationRecoveryCoordinationResult>;
  reselectAndReserveNextTask(
    transition: ContinuationPostMergeTransitionProposal,
  ): Promise<ContinuationReselectionReservationResult>;
}

export type CloudflareContinuationRuntimeResolution =
  | { readonly status: "DISABLED" }
  | { readonly status: "INVALID" }
  | { readonly status: "READY"; readonly runtime: CloudflareContinuationRuntime };

function resolveEnabledBindings(
  bindings: CloudflareContinuationRuntimeBindings,
): { readonly database: D1DatabaseLike; readonly github: CloudflareGitHubRuntimeBindings } | null {
  try {
    const database = bindings.CONTROL_DB;
    const privateKey = bindings.GITHUB_APP_PRIVATE_KEY_PEM;
    const clientId = bindings.GITHUB_APP_CLIENT_ID;
    const installationId = bindings.GITHUB_APP_INSTALLATION_ID;

    if (
      !database ||
      typeof database.prepare !== "function" ||
      typeof privateKey !== "string" ||
      typeof clientId !== "string" ||
      typeof installationId !== "string"
    ) {
      return null;
    }

    return {
      database,
      github: {
        GITHUB_APP_PRIVATE_KEY_PEM: privateKey,
        GITHUB_APP_CLIENT_ID: clientId,
        GITHUB_APP_INSTALLATION_ID: installationId,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Compose the already-reviewed continuation recovery/re-selection/persistence
 * boundaries without activating them.
 *
 * The exact feature flag is checked before any D1 or GitHub continuation binding
 * is inspected. READY construction performs no I/O; D1/GitHub work occurs only
 * when an explicit runtime method is called. The runtime never starts/schedules
 * a task and grants no merge, deploy or later mutation authority.
 */
export function resolveCloudflareContinuationRuntime(
  bindings: CloudflareContinuationRuntimeBindings,
  options: CloudflareContinuationRuntimeOptions = {},
): CloudflareContinuationRuntimeResolution {
  if (!bindings || typeof bindings !== "object") return { status: "INVALID" };
  if (bindings.CONTROL_CONTINUATION_RUNTIME_ENABLED !== "true") {
    return { status: "DISABLED" };
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    return { status: "INVALID" };
  }
  if (options.fetchRequest !== undefined && typeof options.fetchRequest !== "function") {
    return { status: "INVALID" };
  }

  const resolved = resolveEnabledBindings(bindings);
  if (!resolved) return { status: "INVALID" };

  let githubRuntime;
  try {
    githubRuntime = createCloudflareGitHubReadRuntime({
      bindings: resolved.github,
      fetchRequest: options.fetchRequest,
    });
  } catch {
    return { status: "INVALID" };
  }

  const now = options.now ?? (() => new Date().toISOString());
  const reader = new D1ContinuationCampaignReader(resolved.database);
  const store = new D1ContinuationNextTaskStore(resolved.database);

  return {
    status: "READY",
    runtime: {
      async recoverAndCoordinate(identity) {
        const observedAt = now();
        const context = githubRuntime.createRepositoryReadContext(identity.repository, observedAt);
        return recoverAndCoordinateAuthoritativeContinuation(reader, identity, {
          provider: context.provider,
          now: () => observedAt,
        });
      },

      async reselectAndReserveNextTask(transition) {
        const observedAt = now();
        const context = githubRuntime.createRepositoryReadContext(
          transition.campaign.repository,
          observedAt,
        );
        const plan = await reselectContinuationAfterMerge(transition, {
          provider: context.provider,
          now: () => observedAt,
        });
        if (plan.kind !== "READY") {
          return { kind: "NO_RESERVATION", plan };
        }

        const nextTaskTransition = planContinuationNextTaskTransition(transition, plan);
        const persistence = await store.persist(transition, nextTaskTransition);
        return { kind: "RESERVED", plan, persistence };
      },
    },
  };
}
