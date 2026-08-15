import {
  type GitHubInstallationReadScope,
} from "./app-installation-read-contract.js";
import {
  GitHubAppSessionError,
  createGitHubAppInstallationSessionProvider,
  type GitHubAppInstallationSessionDependencies,
} from "./app-installation-session.js";
import {
  GITHUB_GRAPHQL_DASHBOARD_OPERATION,
  GITHUB_GRAPHQL_DASHBOARD_QUERY,
  type GitHubAuthorizedDashboardGraphqlQuery,
  type GitHubInstallationAuthorizedDashboardGraphqlSession,
  type GitHubInstallationAuthorizedDashboardGraphqlSessionProvider,
} from "./graphql-dashboard-snapshot.js";
import {
  GITHUB_GRAPHQL_ACCEPT,
  GITHUB_GRAPHQL_CONTENT_TYPE,
  GITHUB_GRAPHQL_ENDPOINT,
} from "./graphql-merge-state-transport.js";

function capturedCredential(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || /[\r\n]/.test(value)) return null;
  return value;
}

async function captureTokenCredential(response: Response): Promise<string | null> {
  if (response.status !== 201) return null;
  const rawContentType = response.headers.get("content-type");
  const mediaType = rawContentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) return null;
  try {
    const payload = await response.clone().json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return capturedCredential((payload as Record<string, unknown>).token);
  } catch {
    return null;
  }
}

function assertExactVariableKeys(request: GitHubAuthorizedDashboardGraphqlQuery): void {
  const keys = Object.keys(request.variables).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["name", "owner"])) {
    throw new GitHubAppSessionError("GRAPHQL_REQUEST_INVALID");
  }
}

function assertAuthorizedDashboardRequest(
  request: GitHubAuthorizedDashboardGraphqlQuery,
  scope: GitHubInstallationReadScope,
): void {
  if (
    request.method !== "POST" ||
    request.url !== GITHUB_GRAPHQL_ENDPOINT ||
    request.accept !== GITHUB_GRAPHQL_ACCEPT ||
    request.contentType !== GITHUB_GRAPHQL_CONTENT_TYPE ||
    request.operationName !== GITHUB_GRAPHQL_DASHBOARD_OPERATION ||
    request.query !== GITHUB_GRAPHQL_DASHBOARD_QUERY ||
    request.redirect !== "manual"
  ) {
    throw new GitHubAppSessionError("GRAPHQL_REQUEST_INVALID");
  }

  assertExactVariableKeys(request);
  if (
    typeof request.variables.owner !== "string" ||
    request.variables.owner === "" ||
    typeof request.variables.name !== "string" ||
    request.variables.name === ""
  ) {
    throw new GitHubAppSessionError("GRAPHQL_REQUEST_INVALID");
  }

  const repository = `${request.variables.owner}/${request.variables.name}`.toLowerCase();
  if (!scope.repositories.some((candidate) => candidate.toLowerCase() === repository)) {
    throw new GitHubAppSessionError("GRAPHQL_REQUEST_INVALID");
  }
  for (const permission of ["metadata", "contents", "issues", "pull_requests", "checks", "actions"] as const) {
    if (scope.permissions[permission] !== "read") {
      throw new GitHubAppSessionError("GRAPHQL_REQUEST_INVALID");
    }
  }
  if (scope.permissions.statuses !== undefined) {
    throw new GitHubAppSessionError("GRAPHQL_REQUEST_INVALID");
  }
}

function authorizedDashboardSession(
  scope: GitHubInstallationReadScope,
  credentialLease: GitHubInstallationAuthorizedDashboardGraphqlSession["credentialLease"],
  rawCredential: string,
  dependencies: GitHubAppInstallationSessionDependencies,
): GitHubInstallationAuthorizedDashboardGraphqlSession {
  return {
    credentialLease,
    async execute(request) {
      assertAuthorizedDashboardRequest(request, scope);
      try {
        return await dependencies.fetchRequest(
          new Request(GITHUB_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
              Accept: GITHUB_GRAPHQL_ACCEPT,
              Authorization: `Bearer ${rawCredential}`,
              "Content-Type": GITHUB_GRAPHQL_CONTENT_TYPE,
            },
            body: JSON.stringify({
              operationName: GITHUB_GRAPHQL_DASHBOARD_OPERATION,
              query: GITHUB_GRAPHQL_DASHBOARD_QUERY,
              variables: request.variables,
            }),
            redirect: "manual",
          }),
        );
      } catch {
        throw new GitHubAppSessionError("GRAPHQL_TRANSPORT_FAILED");
      }
    },
  };
}

export function createGitHubAppInstallationDashboardGraphqlSessionProvider(
  dependencies: GitHubAppInstallationSessionDependencies,
): GitHubInstallationAuthorizedDashboardGraphqlSessionProvider {
  return async (scope: GitHubInstallationReadScope, observedAt: string) => {
    let rawCredential: string | null = null;
    const readProvider = createGitHubAppInstallationSessionProvider({
      ...dependencies,
      fetchRequest: async (request) => {
        const response = await dependencies.fetchRequest(request);
        rawCredential = await captureTokenCredential(response);
        return response;
      },
    });
    const readSession = await readProvider(scope, observedAt);
    if (rawCredential === null) throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE");
    return authorizedDashboardSession(scope, readSession.credentialLease, rawCredential, dependencies);
  };
}
