import {
  acceptAuthenticatedRpi5Observation,
  type Rpi5ObservationAtomicD1DatabaseLike,
  type Rpi5ObservationAtomicIngestionInput,
} from "./rpi5-observation-atomic-ingestion.js";
import {
  normalizeRpi5ObservationVerificationKeyRegistry,
  type Rpi5ObservationVerificationKeyRegistry,
} from "../../shared/rpi5-observation-verification-keys.js";

export interface Rpi5ObservationRuntimeBindings {
  readonly CONTROL_RPI5_OBSERVATION_INGEST_ENABLED?: unknown;
  readonly CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS?: unknown;
  readonly CONTROL_DB?: unknown;
}

export interface Rpi5ObservationWorkerRuntime {
  ingest(
    metadata: unknown,
    payload: Uint8Array,
    now: string,
  ): Promise<void>;
}

export type Rpi5ObservationRuntimeResolution =
  | { readonly status: "DISABLED" }
  | { readonly status: "INVALID" }
  | {
      readonly status: "READY";
      readonly runtime: Rpi5ObservationWorkerRuntime;
    };

export function rpi5ObservationIngestEnabled(value: unknown): boolean {
  return value === "true";
}

function requireVerificationKeyRegistry(
  value: unknown,
): Rpi5ObservationVerificationKeyRegistry {
  if (typeof value !== "string") {
    throw new Error("invalid RPi5 observation verification-key registry binding");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("invalid RPi5 observation verification-key registry binding");
  }
  return normalizeRpi5ObservationVerificationKeyRegistry(parsed);
}

function requireObservationDatabase(value: unknown): Rpi5ObservationAtomicD1DatabaseLike {
  if (!value || typeof value !== "object") {
    throw new Error("invalid RPi5 observation database binding");
  }
  const database = value as Partial<Rpi5ObservationAtomicD1DatabaseLike>;
  if (typeof database.prepare !== "function" || typeof database.batch !== "function") {
    throw new Error("invalid RPi5 observation database binding");
  }
  return database as Rpi5ObservationAtomicD1DatabaseLike;
}

/**
 * Source-level Phase 5 runtime composition. Production remains dormant unless the
 * exact opt-in is present. The resolver only validates already-provisioned public
 * verification-key material and the existing D1 binding; it does not provision,
 * rotate, migrate or remotely mutate either dependency.
 */
export function resolveRpi5ObservationRuntime(
  bindings: Rpi5ObservationRuntimeBindings,
): Rpi5ObservationRuntimeResolution {
  if (!rpi5ObservationIngestEnabled(bindings.CONTROL_RPI5_OBSERVATION_INGEST_ENABLED)) {
    return { status: "DISABLED" };
  }

  let verificationKeyRegistry: Rpi5ObservationVerificationKeyRegistry;
  let database: Rpi5ObservationAtomicD1DatabaseLike;
  try {
    verificationKeyRegistry = requireVerificationKeyRegistry(
      bindings.CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS,
    );
    database = requireObservationDatabase(bindings.CONTROL_DB);
  } catch {
    return { status: "INVALID" };
  }

  return {
    status: "READY",
    runtime: {
      async ingest(metadata, payload, now) {
        const input: Rpi5ObservationAtomicIngestionInput = {
          metadata,
          payload,
          verificationKeyRegistry,
          database,
          now,
        };
        await acceptAuthenticatedRpi5Observation(input);
      },
    },
  };
}
