import type { ControlDashboardData } from "../../shared/control-model.js";
import { readLiveDashboardSnapshot } from "../../shared/live-dashboard.js";
import { createGitHubAppInstallationDashboardGraphqlSessionProvider } from "./app-installation-dashboard-session.js";
import type { GitHubAppCredentialFetch } from "./app-installation-session.js";
import { buildPhase2GitHubReadScopeForStage } from "./app-read-rollout-plan.js";
import {
  createCloudflareGitHubAppJwtSigner,
  createCloudflareGitHubCredentialFetch,
  createCloudflareGitHubReadRuntime,
  type CloudflareGitHubRuntimeBindings,
} from "./cloudflare-worker-runtime.js";
import { createGitHubDashboardReadContextFactory } from "./graphql-dashboard-snapshot.js";

export interface CloudflareGitHubDashboardSnapshotOptions {
  readonly bindings: CloudflareGitHubRuntimeBindings;
  readonly observedAt: string;
  readonly fetchRequest?: GitHubAppCredentialFetch;
}

export async function readCloudflareGitHubDashboardSnapshot(
  options: CloudflareGitHubDashboardSnapshotOptions,
): Promise<ControlDashboardData> {
  const validatedRuntime = createCloudflareGitHubReadRuntime({
    bindings: options.bindings,
    fetchRequest: options.fetchRequest,
  });
  const fetchRequest = createCloudflareGitHubCredentialFetch(options.fetchRequest);
  const acquireSession = createGitHubAppInstallationDashboardGraphqlSessionProvider({
    identity: { clientId: validatedRuntime.clientId },
    signer: createCloudflareGitHubAppJwtSigner(options.bindings.GITHUB_APP_PRIVATE_KEY_PEM),
    fetchRequest,
  });
  const scope = buildPhase2GitHubReadScopeForStage(validatedRuntime.installationId, "actions");
  const factory = await createGitHubDashboardReadContextFactory({
    scope,
    observedAt: options.observedAt,
    acquireSession,
  });
  return readLiveDashboardSnapshot(factory, options.observedAt);
}
