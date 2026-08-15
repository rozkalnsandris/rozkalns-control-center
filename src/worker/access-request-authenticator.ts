import {
  CloudflareAccessJwksResolver,
  type CloudflareAccessJwksFetch,
} from "../integrations/cloudflare/access-jwks-resolver";
import {
  CloudflareAccessJwtVerifier,
  type CloudflareAccessPrincipal,
} from "../integrations/cloudflare/access-jwt-verifier";

export type CloudflareAccessAuthenticationErrorCode = "ACCESS_AUTHENTICATION_FAILED";

export class CloudflareAccessAuthenticationError extends Error {
  readonly code: CloudflareAccessAuthenticationErrorCode;

  constructor() {
    super("ACCESS_AUTHENTICATION_FAILED");
    this.name = "CloudflareAccessAuthenticationError";
    this.code = "ACCESS_AUTHENTICATION_FAILED";
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

function authenticationFailed(): never {
  throw new CloudflareAccessAuthenticationError();
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
    } catch {
      authenticationFailed();
    }
  }
}
