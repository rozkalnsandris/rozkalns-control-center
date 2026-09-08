import {
  D1Rpi5ObservationAcceptanceStore,
  type Rpi5ObservationAcceptanceD1DatabaseLike,
  type Rpi5ObservationAcceptanceResult,
} from "./d1-rpi5-observation-acceptance-store.js";
import {
  claimRpi5ObservationReplay,
  type Rpi5ObservationReplayD1DatabaseLike,
} from "./d1-rpi5-observation-replay-store.js";
import {
  authenticateRpi5ObservationTransport,
  parseSignedRpi5ObservationPayload,
  type Rpi5ObservationAuthenticationInput,
} from "./rpi5-observation-ingestion.js";
import { normalizeSanitizedProductionVisibility } from "../../shared/production-visibility.js";

export type Rpi5ObservationAtomicD1DatabaseLike =
  Rpi5ObservationAcceptanceD1DatabaseLike & Rpi5ObservationReplayD1DatabaseLike;

export interface Rpi5ObservationAtomicIngestionInput extends Rpi5ObservationAuthenticationInput {
  readonly database: Rpi5ObservationAtomicD1DatabaseLike;
}

/**
 * Runtime composition for one authenticated RPi5 observation.
 *
 * The exact raw bytes are authenticated before any D1 mutation. A valid normalized
 * payload is then accepted through the atomic D1 claim+projection primitive. A
 * correctly signed but malformed/strictly-invalid payload is still durably consumed
 * through the legacy replay-only claim before its original payload error is rethrown;
 * ACTIVE_REPLAY or D1 failure from that claim takes precedence exactly as before.
 *
 * This source boundary does not enable the Worker route, provision keys, apply D1
 * migrations remotely or acquire any protected-host evidence.
 */
export async function acceptAuthenticatedRpi5Observation(
  input: Rpi5ObservationAtomicIngestionInput,
): Promise<Rpi5ObservationAcceptanceResult> {
  const verified = await authenticateRpi5ObservationTransport(input);

  let visibility;
  try {
    const parsedPayload = parseSignedRpi5ObservationPayload(input.payload);
    visibility = normalizeSanitizedProductionVisibility(parsedPayload, input.now);
  } catch (error) {
    await claimRpi5ObservationReplay(input.database, {
      replayKey: verified.replayKey,
      replayExpiresAt: verified.replayExpiresAt,
      claimedAt: input.now,
    });
    throw error;
  }

  const acceptanceStore = new D1Rpi5ObservationAcceptanceStore(input.database);
  return acceptanceStore.accept({
    replayKey: verified.replayKey,
    replayExpiresAt: verified.replayExpiresAt,
    visibility,
    acceptedAt: input.now,
  });
}
