import {
  CloudflareAccessRequestAuthenticator,
  type CloudflareAccessRequestAuthenticatorDependencies,
} from "./access-request-authenticator.js";
import { AccessJwksManualFetchProbe } from "./access-jwks-manual-fetch-probe.js";

export interface AccessAuthCanaryRuntimeBindings {
  readonly CONTROL_ACCESS_AUTH_CANARY_ENABLED?: unknown;
  readonly CONTROL_ACCESS_ISSUER?: unknown;
  readonly CONTROL_ACCESS_AUDIENCE?: unknown;
}

export type AccessAuthCanaryRuntimeResolution =
  | { readonly status: "DISABLED"; readonly authenticator: null }
  | { readonly status: "INVALID_CONFIGURATION"; readonly authenticator: null }
  | {
      readonly status: "READY";
      readonly authenticator: CloudflareAccessRequestAuthenticator;
      readonly jwksFetchProbe: AccessJwksManualFetchProbe;
    };

function readConfiguredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed !== value) {
    return null;
  }
  return trimmed;
}

export function resolveAccessAuthCanaryRuntime(
  bindings: AccessAuthCanaryRuntimeBindings,
  dependencies: CloudflareAccessRequestAuthenticatorDependencies = {},
): AccessAuthCanaryRuntimeResolution {
  if (bindings.CONTROL_ACCESS_AUTH_CANARY_ENABLED !== "true") {
    return { status: "DISABLED", authenticator: null };
  }

  const issuer = readConfiguredString(bindings.CONTROL_ACCESS_ISSUER);
  const audience = readConfiguredString(bindings.CONTROL_ACCESS_AUDIENCE);
  if (!issuer || !audience) {
    return { status: "INVALID_CONFIGURATION", authenticator: null };
  }

  try {
    return {
      status: "READY",
      authenticator: new CloudflareAccessRequestAuthenticator(
        { issuer, audience },
        dependencies,
      ),
      jwksFetchProbe: new AccessJwksManualFetchProbe({
        issuer,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      }),
    };
  } catch {
    return { status: "INVALID_CONFIGURATION", authenticator: null };
  }
}
