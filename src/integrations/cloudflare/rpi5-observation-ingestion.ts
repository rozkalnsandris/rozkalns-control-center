import {
  claimRpi5ObservationReplay,
  type Rpi5ObservationReplayD1DatabaseLike,
} from "./d1-rpi5-observation-replay-store.js";
import {
  normalizeSanitizedProductionVisibility,
  type ProductionVisibilityReadModel,
} from "../../shared/production-visibility.js";
import {
  normalizeRpi5ObservationDeliveryMetadata,
  verifyRpi5ObservationDeliverySignature,
} from "../../shared/rpi5-observation-transport.js";
import { resolveRpi5ObservationVerificationKey } from "../../shared/rpi5-observation-verification-keys.js";

export type Rpi5ObservationIngestionErrorCode = "INVALID_PAYLOAD";

export class Rpi5ObservationIngestionError extends Error {
  readonly code: Rpi5ObservationIngestionErrorCode;

  constructor(code: Rpi5ObservationIngestionErrorCode) {
    super("RPi5 observation ingestion failed closed");
    this.name = "Rpi5ObservationIngestionError";
    this.code = code;
  }
}

export interface Rpi5ObservationIngestionInput {
  readonly metadata: unknown;
  readonly payload: Uint8Array;
  readonly verificationKeyRegistry: unknown;
  readonly replayDatabase: Rpi5ObservationReplayD1DatabaseLike;
  readonly now: string;
}

function fail(code: Rpi5ObservationIngestionErrorCode): never {
  throw new Rpi5ObservationIngestionError(code);
}

function parseSignedPayload(payload: Uint8Array): unknown {
  try {
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payload);
    return JSON.parse(json) as unknown;
  } catch {
    fail("INVALID_PAYLOAD");
  }
}

/**
 * Compose the authenticated RPi5 observation boundary without wiring any route,
 * credential source or protected-host access path.
 *
 * Security order is intentional and must not be weakened:
 *   1. normalize delivery metadata/freshness and resolve its exact keyId from the
 *      strict verification-key registry; no default or caller-selected key exists;
 *   2. verify the signature over the exact raw payload bytes with that selected key;
 *   3. atomically claim the verified replay identity in durable D1 state;
 *   4. decode/parse those same raw payload bytes;
 *   5. apply the strict sanitized production-visibility consumer.
 *
 * A successful replay claim is never undone here when later payload parsing or
 * normalization fails. The signed delivery remains consumed and failed closed.
 */
export async function ingestAuthenticatedRpi5Observation(
  input: Rpi5ObservationIngestionInput,
): Promise<ProductionVisibilityReadModel> {
  const metadata = normalizeRpi5ObservationDeliveryMetadata(input.metadata, input.now);
  const verificationKey = await resolveRpi5ObservationVerificationKey(
    input.verificationKeyRegistry,
    metadata.keyId,
  );
  const verified = await verifyRpi5ObservationDeliverySignature(
    metadata,
    input.payload,
    verificationKey,
    input.now,
  );

  await claimRpi5ObservationReplay(input.replayDatabase, {
    replayKey: verified.replayKey,
    replayExpiresAt: verified.replayExpiresAt,
    claimedAt: input.now,
  });

  const parsedPayload = parseSignedPayload(input.payload);
  return normalizeSanitizedProductionVisibility(parsedPayload, input.now);
}
