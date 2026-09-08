import { Rpi5ObservationReplayClaimError } from "../integrations/cloudflare/d1-rpi5-observation-replay-store.js";
import { Rpi5ObservationIngestionError } from "../integrations/cloudflare/rpi5-observation-ingestion.js";
import type { Rpi5ObservationWorkerRuntime } from "../integrations/cloudflare/rpi5-observation-runtime.js";
import { ProductionVisibilityError } from "../shared/production-visibility.js";
import {
  MAX_RPI5_OBSERVATION_PAYLOAD_BYTES,
  Rpi5ObservationTransportError,
} from "../shared/rpi5-observation-transport.js";
import { Rpi5ObservationVerificationKeyRegistryError } from "../shared/rpi5-observation-verification-keys.js";

export const RPI5_OBSERVATION_ROUTE_PATH = "/api/rpi5/observation" as const;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const METADATA_HEADERS = {
  version: "x-rpi5-observation-version",
  deliveryId: "x-rpi5-observation-delivery-id",
  sentAt: "x-rpi5-observation-sent-at",
  keyId: "x-rpi5-observation-key-id",
  signature: "x-rpi5-observation-signature",
} as const;

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json(
    { error },
    {
      status,
      headers: { ...NO_STORE_HEADERS, ...headers },
    },
  );
}

function metadataFromHeaders(headers: Headers): Record<string, string> | null {
  const metadata: Record<string, string> = {};
  for (const [field, header] of Object.entries(METADATA_HEADERS)) {
    const value = headers.get(header);
    if (value === null || value.length === 0) return null;
    metadata[field] = value;
  }
  return metadata;
}

function mapIngestionError(error: unknown): Response {
  if (
    error instanceof Rpi5ObservationVerificationKeyRegistryError ||
    error instanceof Rpi5ObservationTransportError
  ) {
    return jsonError("OBSERVATION_AUTHENTICATION_FAILED", 401);
  }

  if (error instanceof Rpi5ObservationReplayClaimError) {
    if (error.code === "ACTIVE_REPLAY") {
      return jsonError("OBSERVATION_REPLAYED", 409);
    }
    return jsonError("OBSERVATION_INGEST_UNAVAILABLE", 503);
  }

  if (error instanceof Rpi5ObservationIngestionError || error instanceof ProductionVisibilityError) {
    return jsonError("INVALID_OBSERVATION_PAYLOAD", 400);
  }

  return jsonError("OBSERVATION_INGEST_UNAVAILABLE", 503);
}

/**
 * Receive exact signed RPi5 observation bytes. A successful response means the
 * existing authenticated ingestion boundary verified and durably claimed the
 * delivery. This route does not persist a production-visibility read model and is
 * deliberately dormant unless the separate runtime resolver is explicitly enabled.
 */
export async function handleRpi5ObservationRequest(
  request: Request,
  now: string,
  runtime: Rpi5ObservationWorkerRuntime | null,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("METHOD_NOT_ALLOWED", 405, { Allow: "POST" });
  }

  if (!runtime) {
    return jsonError("OBSERVATION_INGEST_UNAVAILABLE", 503);
  }

  const metadata = metadataFromHeaders(request.headers);
  if (!metadata) {
    return jsonError("INVALID_OBSERVATION_METADATA", 400);
  }

  let payload: Uint8Array;
  try {
    payload = new Uint8Array(await request.arrayBuffer());
  } catch {
    return jsonError("INVALID_OBSERVATION_PAYLOAD", 400);
  }

  if (payload.byteLength === 0) {
    return jsonError("INVALID_OBSERVATION_PAYLOAD", 400);
  }
  if (payload.byteLength > MAX_RPI5_OBSERVATION_PAYLOAD_BYTES) {
    return jsonError("OBSERVATION_PAYLOAD_TOO_LARGE", 413);
  }

  try {
    await runtime.ingest(metadata, payload, now);
  } catch (error) {
    return mapIngestionError(error);
  }

  return Response.json(
    { status: "AUTHENTICATED_AND_CLAIMED" },
    { status: 202, headers: NO_STORE_HEADERS },
  );
}
