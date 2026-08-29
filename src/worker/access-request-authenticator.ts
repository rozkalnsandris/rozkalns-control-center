import {
  CloudflareAccessJwksError,
  CloudflareAccessJwksResolver,
  type CloudflareAccessJwksErrorCode,
  type CloudflareAccessJwksFetch,
} from "../integrations/cloudflare/access-jwks-resolver.js";
import {
  CloudflareAccessJwtError,
  CloudflareAccessJwtVerifier,
  type CloudflareAccessAudienceDiagnostic,
  type CloudflareAccessJwtErrorCode,
  type CloudflareAccessPrincipal,
} from "../integrations/cloudflare/access-jwt-verifier.js";

export type CloudflareAccessAuthenticationErrorCode = "ACCESS_AUTHENTICATION_FAILED";
export type CloudflareAccessAuthenticationFailureReason =
  | CloudflareAccessJwtErrorCode
  | CloudflareAccessJwksErrorCode
  | "ACCESS_AUTHENTICATION_INTERNAL";

export class CloudflareAccessAuthenticationError extends Error {
  readonly code: CloudflareAccessAuthenticationErrorCode;
  readonly reason: CloudflareAccessAuthenticationFailureReason;
  readonly audienceDiagnostic: CloudflareAccessAudienceDiagnostic | null;

  constructor(
    reason: CloudflareAccessAuthenticationFailureReason,
    audienceDiagnostic: CloudflareAccessAudienceDiagnostic | null = null,
  ) {
    super("ACCESS_AUTHENTICATION_FAILED");
    this.name = "CloudflareAccessAuthenticationError";
    this.code = "ACCESS_AUTHENTICATION_FAILED";
    this.reason = reason;
    this.audienceDiagnostic = audienceDiagnostic;
  }
}

export interface CloudflareAccessRequestAuthenticatorConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
}

export interface CloudflareAccessRequestAuthenticatorDependencies {
  readonly fetch?: CloudflareAccessJwksFetch;
  readonly clock?: () => Date;
}

function authenticationFailed(error: unknown): never {
  const reason: CloudflareAccessAuthenticationFailureReason =
    error instanceof CloudflareAccessJwtError || error instanceof CloudflareAccessJwksError
      ? error.code
      : "ACCESS_AUTHENTICATION_INTERNAL";
  const audienceDiagnostic = error instanceof CloudflareAccessJwtError
    ? error.audienceDiagnostic
    : null;
  throw new CloudflareAccessAuthenticationError(reason, audienceDiagnostic);
}

export class CloudflareAccessRequestAuthenticator {
  readonly #verifier: CloudflareAccessJwtVerifier;
  readonly #clock: () => Date;

  constructor(
    config: CloudflareAccessRequestAuthenticatorConfig,
    dependencies: CloudflareAccessRequestAuthenticatorDependencies = {},
  ) {
    this.#clock = dependencies.clock ?? (() => new Date());

    const resolver = new CloudflareAccessJwksResolver({
      issuer: config.issuer,
      ...(config.cacheTtlMs === undefined ? {} : { cacheTtlMs: config.cacheTtlMs }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      now: () => this.#clock().getTime(),
    });

    this.#verifier = new CloudflareAccessJwtVerifier(
      { issuer: config.issuer, audience: config.audience },
      resolver,
    );
  }

  async authenticateRequest(request: Request): Promise<CloudflareAccessPrincipal> {
    try {
      const principal = await this.#verifier.verifyRequest(request, this.#clock());
      return { subject: principal.subject, email: principal.email };
    } catch (error) {
      authenticationFailed(error);
    }
  }
}
