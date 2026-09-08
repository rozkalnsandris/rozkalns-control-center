import {
  claimRpi5ObservationReplay,
  type Rpi5ObservationReplayD1DatabaseLike,
} from "./d1-rpi5-observation-replay-store.js";
import {
  normalizeSanitizedProductionVisibility,
  type ProductionVisibilityReadModel,
} from "../../shared/production-visibility.js";
import { verifyRpi5ObservationDeliverySignature } from "../../shared/rpi5-observation-transport.js";

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
  readonly verificationKey: CryptoKey;
  readonly replayDatabase: Rpi5ObservationReplayD1DatabaseLike;
  readonly now: string;
}

function fail(code: Rpi5ObservationIngestionErrorCode): never {
  throw new Rpi5ObservationIngestionError(code);
}

function parseSignedPayload(payload: Uint8Array): unknown {
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
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
 *   1. verify delivery metadata/freshness/signature over the exact raw payload bytes;
 *   2. atomically claim the verified replay identity in durable D1 state;
 *   3. decode/parse those same raw payload bytes;
 *   4. apply the strict sanitized production-visibility consumer.
 *
 * A successful replay claim is never undone here when later payload parsing or
 * normalization fails. The signed delivery remains consumed and failed closed.
 */
export async function ingestAuthenticatedRpi5Observation(
  input: Rpi5ObservationIngestionInput,
): Promise<ProductionVisibilityReadModel> {
  const verified = await verifyRpi5ObservationDeliverySignature(
    input.metadata,
    input.payload,
    input.verificationKey,
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
