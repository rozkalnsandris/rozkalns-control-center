import { GitHubAppSessionError } from "./app-installation-session.js";
import type { GitHubInstallationReadTransport } from "./app-installation-read-contract.js";
import {
  createGitHubGraphqlMergeStateTransport,
  GitHubGraphqlMergeStateError,
  type GitHubGraphqlMergeStateFailureCode,
  type GitHubGraphqlMergeStateTransport,
  type GitHubInstallationAuthorizedGraphqlQuerySessionProvider,
} from "./graphql-merge-state-transport.js";
import {
  createGitHubRestReadTransport,
  GitHubRestReadError,
  type GitHubInstallationAuthorizedReadSessionProvider,
  type GitHubRestReadFailureCode,
} from "./rest-read-transport.js";

function restFailureCode(error: GitHubAppSessionError): GitHubRestReadFailureCode {
  switch (error.code) {
    case "TOKEN_UNAUTHORIZED":
      return "UNAUTHORIZED";
    case "TOKEN_FORBIDDEN":
      return "FORBIDDEN";
    case "TOKEN_NOT_FOUND":
      return "NOT_FOUND";
    case "TOKEN_SCOPE_REJECTED":
    case "TOKEN_SCOPE_MISMATCH":
    case "READ_REQUEST_INVALID":
    case "GRAPHQL_REQUEST_INVALID":
      return "INVALID_REQUEST";
    case "TOKEN_MALFORMED_RESPONSE":
      return "MALFORMED_RESPONSE";
    case "TOKEN_UNUSABLE":
      return "CREDENTIAL_UNUSABLE";
    case "TOKEN_EXCHANGE_FAILED":
      return error.status === null ? "TRANSPORT_FAILURE" : "UNEXPECTED_STATUS";
    case "READ_TRANSPORT_FAILED":
    case "GRAPHQL_TRANSPORT_FAILED":
      return "TRANSPORT_FAILURE";
    case "INVALID_APP_IDENTITY":
    case "INVALID_TIME":
    case "SIGNING_FAILED":
    default:
      return "CREDENTIAL_UNAVAILABLE";
  }
}

function graphqlFailureCode(error: GitHubAppSessionError): GitHubGraphqlMergeStateFailureCode {
  switch (error.code) {
    case "TOKEN_UNAUTHORIZED":
      return "UNAUTHORIZED";
    case "TOKEN_FORBIDDEN":
      return "FORBIDDEN";
    case "TOKEN_NOT_FOUND":
      return "RESOURCE_NOT_FOUND";
    case "TOKEN_SCOPE_REJECTED":
    case "TOKEN_SCOPE_MISMATCH":
    case "READ_REQUEST_INVALID":
    case "GRAPHQL_REQUEST_INVALID":
      return "INVALID_REQUEST";
    case "TOKEN_MALFORMED_RESPONSE":
      return "MALFORMED_RESPONSE";
    case "TOKEN_UNUSABLE":
      return "CREDENTIAL_UNUSABLE";
    case "TOKEN_EXCHANGE_FAILED":
      return error.status === null ? "TRANSPORT_FAILURE" : "UNEXPECTED_STATUS";
    case "READ_TRANSPORT_FAILED":
    case "GRAPHQL_TRANSPORT_FAILED":
      return "TRANSPORT_FAILURE";
    case "INVALID_APP_IDENTITY":
    case "INVALID_TIME":
    case "SIGNING_FAILED":
    default:
      return "CREDENTIAL_UNAVAILABLE";
  }
}

export function createGitHubCredentialDiagnosticRestTransport(
  acquireSession: GitHubInstallationAuthorizedReadSessionProvider,
): GitHubInstallationReadTransport {
  return {
    async get(scope, request, observedAt) {
      let session;
      try {
        session = await acquireSession(scope, observedAt);
      } catch (error) {
        if (error instanceof GitHubAppSessionError) {
          throw new GitHubRestReadError(restFailureCode(error), { status: error.status });
        }
        throw new GitHubRestReadError("CREDENTIAL_UNAVAILABLE");
      }

      return createGitHubRestReadTransport(async () => session).get(scope, request, observedAt);
    },
  };
}

export function createGitHubCredentialDiagnosticGraphqlTransport(
  acquireSession: GitHubInstallationAuthorizedGraphqlQuerySessionProvider,
): GitHubGraphqlMergeStateTransport {
  return {
    async read(scope, request, observedAt) {
      let session;
      try {
        session = await acquireSession(scope, observedAt);
      } catch (error) {
        if (error instanceof GitHubAppSessionError) {
          throw new GitHubGraphqlMergeStateError(graphqlFailureCode(error), { status: error.status });
        }
        throw new GitHubGraphqlMergeStateError("CREDENTIAL_UNAVAILABLE");
      }

      return createGitHubGraphqlMergeStateTransport(async () => session).read(scope, request, observedAt);
    },
  };
}
