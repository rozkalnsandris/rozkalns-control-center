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
  createGitHubRestConditionalCache,
  createGitHubRestReadTransport,
  GitHubRestReadError,
  type GitHubInstallationAuthorizedReadSessionProvider,
  type GitHubRestConditionalCache,
  type GitHubRestReadFailureCode,
} from "./rest-read-transport.js";

export type GitHubTransportDiagnosticStage = "token-exchange";

export class GitHubTransportStageDiagnosticError extends Error {
  readonly stage: GitHubTransportDiagnosticStage;

  constructor(stage: GitHubTransportDiagnosticStage) {
    super("GitHub transport failed at a bounded diagnostic stage");
    this.name = "GitHubTransportStageDiagnosticError";
    this.stage = stage;
  }
}

export type GitHubValidationDiagnosticCode =
  | "TOKEN_SCOPE_REJECTED"
  | "TOKEN_SCOPE_MISMATCH"
  | "READ_REQUEST_INVALID"
  | "GRAPHQL_REQUEST_INVALID";

export class GitHubRestValidationDiagnosticError extends GitHubRestReadError {
  readonly diagnosticCode: GitHubValidationDiagnosticCode;

  constructor(diagnosticCode: GitHubValidationDiagnosticCode) {
    super("INVALID_REQUEST");
    this.name = "GitHubRestValidationDiagnosticError";
    this.diagnosticCode = diagnosticCode;
  }
}

export class GitHubGraphqlValidationDiagnosticError extends GitHubGraphqlMergeStateError {
  readonly diagnosticCode: GitHubValidationDiagnosticCode;

  constructor(diagnosticCode: GitHubValidationDiagnosticCode) {
    super("INVALID_REQUEST");
    this.name = "GitHubGraphqlValidationDiagnosticError";
    this.diagnosticCode = diagnosticCode;
  }
}

function validationDiagnosticCode(error: GitHubAppSessionError): GitHubValidationDiagnosticCode | null {
  switch (error.code) {
    case "TOKEN_SCOPE_REJECTED":
    case "TOKEN_SCOPE_MISMATCH":
    case "READ_REQUEST_INVALID":
    case "GRAPHQL_REQUEST_INVALID":
      return error.code;
    default:
      return null;
  }
}

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
      return "UNEXPECTED_STATUS";
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
      return "UNEXPECTED_STATUS";
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

function tokenExchangeTransportFailure(error: GitHubAppSessionError): boolean {
  return error.code === "TOKEN_EXCHANGE_FAILED" && error.status === null;
}

export function createGitHubCredentialDiagnosticRestTransport(
  acquireSession: GitHubInstallationAuthorizedReadSessionProvider,
  conditionalCache: GitHubRestConditionalCache = createGitHubRestConditionalCache(),
): GitHubInstallationReadTransport {
  return {
    async get(scope, request, observedAt, options) {
      let session;
      try {
        session = await acquireSession(scope, observedAt);
      } catch (error) {
        if (error instanceof GitHubAppSessionError) {
          const validationCode = validationDiagnosticCode(error);
          if (validationCode !== null) {
            throw new GitHubRestValidationDiagnosticError(validationCode);
          }
          if (tokenExchangeTransportFailure(error)) {
            throw new GitHubTransportStageDiagnosticError("token-exchange");
          }
          throw new GitHubRestReadError(restFailureCode(error), { status: error.status });
        }
        throw new GitHubRestReadError("CREDENTIAL_UNAVAILABLE");
      }
      return createGitHubRestReadTransport(
        async () => session,
        { conditionalCache },
      ).get(scope, request, observedAt, options);
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
          const validationCode = validationDiagnosticCode(error);
          if (validationCode !== null) {
            throw new GitHubGraphqlValidationDiagnosticError(validationCode);
          }
          if (tokenExchangeTransportFailure(error)) {
            throw new GitHubTransportStageDiagnosticError("token-exchange");
          }
          throw new GitHubGraphqlMergeStateError(graphqlFailureCode(error), { status: error.status });
        }
        throw new GitHubGraphqlMergeStateError("CREDENTIAL_UNAVAILABLE");
      }

      return createGitHubGraphqlMergeStateTransport(async () => session).read(scope, request, observedAt);
    },
  };
}
