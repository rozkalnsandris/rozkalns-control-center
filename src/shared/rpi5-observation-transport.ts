export const RPI5_OBSERVATION_TRANSPORT_VERSION = "control-phase5-rpi5-observation-v1" as const;
export const RPI5_OBSERVATION_SIGNING_DOMAIN =
  "rozkalns-control-center.phase5.rpi5-production-visibility.v1" as const;
export const MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS = 5 * 60_000;
export const MAX_RPI5_OBSERVATION_PAYLOAD_BYTES = 16 * 1024;

export interface Rpi5ObservationDeliveryMetadata {
  readonly version: typeof RPI5_OBSERVATION_TRANSPORT_VERSION;
  readonly deliveryId: string;
  readonly sentAt: string;
  readonly keyId: string;
  readonly signature: string;
}

export interface Rpi5ObservationUnsignedMetadata {
  readonly version: typeof RPI5_OBSERVATION_TRANSPORT_VERSION;
  readonly deliveryId: string;
  readonly sentAt: string;
  readonly keyId: string;
}

export interface VerifiedRpi5ObservationSignature {
  readonly metadata: Rpi5ObservationDeliveryMetadata;
  /**
   * Stable replay identity for a separately reviewed durable claim.
   * Signature verification alone does not prove that this delivery is unique.
   */
  readonly replayKey: string;
  readonly replayExpiresAt: string;
}

export type Rpi5ObservationTransportErrorCode =
  | "INVALID_INPUT"
  | "UNEXPECTED_FIELD"
  | "STALE_DELIVERY"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_KEY"
  | "INVALID_SIGNATURE";

export class Rpi5ObservationTransportError extends Error {
  readonly code: Rpi5ObservationTransportErrorCode;

  constructor(code: Rpi5ObservationTransportErrorCode) {
    super("RPi5 observation transport failed closed");
    this.name = "Rpi5ObservationTransportError";
    this.code = code;
  }
}

const DELIVERY_METADATA_FIELDS = ["version", "deliveryId", "sentAt", "keyId", "signature"] as const;
const DELIVERY_METADATA_FIELD_SET = new Set<string>(DELIVERY_METADATA_FIELDS);
const DELIVERY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const textEncoder = new TextEncoder();

function fail(code: Rpi5ObservationTransportErrorCode): never {
  throw new Rpi5ObservationTransportError(code);
}

function requireCanonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requirePayloadBytes(payload: Uint8Array): Uint8Array {
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0) fail("INVALID_INPUT");
  if (payload.byteLength > MAX_RPI5_OBSERVATION_PAYLOAD_BYTES) fail("PAYLOAD_TOO_LARGE");
  return payload;
}

function decodeEd25519Signature(value: string): Uint8Array {
  if (!ED25519_SIGNATURE_PATTERN.test(value)) fail("INVALID_INPUT");

  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}==`;
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    fail("INVALID_INPUT");
  }
  if (binary.length !== 64) fail("INVALID_INPUT");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function requireUnsignedMetadata(
  metadata: Rpi5ObservationUnsignedMetadata,
): Rpi5ObservationUnsignedMetadata {
  if (metadata.version !== RPI5_OBSERVATION_TRANSPORT_VERSION) fail("INVALID_INPUT");
  if (!DELIVERY_ID_PATTERN.test(metadata.deliveryId)) fail("INVALID_INPUT");
  const sentAt = requireCanonicalTimestamp(metadata.sentAt);
  if (!KEY_ID_PATTERN.test(metadata.keyId)) fail("INVALID_INPUT");
  return {
    version: RPI5_OBSERVATION_TRANSPORT_VERSION,
    deliveryId: metadata.deliveryId,
    sentAt,
    keyId: metadata.keyId,
  };
}

export function normalizeRpi5ObservationDeliveryMetadata(
  input: unknown,
  nowInput: string,
): Rpi5ObservationDeliveryMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_INPUT");

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_INPUT");

  const record = input as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !DELIVERY_METADATA_FIELD_SET.has(key)) {
      fail("UNEXPECTED_FIELD");
    }
  }
  for (const key of DELIVERY_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) fail("INVALID_INPUT");
  }

  const unsigned = requireUnsignedMetadata({
    version: record.version as typeof RPI5_OBSERVATION_TRANSPORT_VERSION,
    deliveryId: record.deliveryId as string,
    sentAt: record.sentAt as string,
    keyId: record.keyId as string,
  });
  const now = requireCanonicalTimestamp(nowInput);
  const age = Date.parse(now) - Date.parse(unsigned.sentAt);
  if (age < 0 || age > MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS) fail("STALE_DELIVERY");

  if (typeof record.signature !== "string") fail("INVALID_INPUT");
  decodeEd25519Signature(record.signature);

  return {
    ...unsigned,
    signature: record.signature,
  };
}

/**
 * Build the exact byte sequence that the RPi5 producer must sign.
 *
 * The prefix is newline-delimited and domain-separated; the payload is appended as
 * exact raw bytes so JSON reserialization cannot silently change what was signed.
 */
export function buildRpi5ObservationSigningInput(
  metadata: Rpi5ObservationUnsignedMetadata,
  payloadInput: Uint8Array,
): Uint8Array {
  const normalized = requireUnsignedMetadata(metadata);
  const payload = requirePayloadBytes(payloadInput);
  const prefix = textEncoder.encode(
    `${RPI5_OBSERVATION_SIGNING_DOMAIN}\n${normalized.version}\n${normalized.deliveryId}\n${normalized.sentAt}\n${normalized.keyId}\n${payload.byteLength}\n`,
  );
  const signingInput = new Uint8Array(prefix.byteLength + payload.byteLength);
  signingInput.set(prefix, 0);
  signingInput.set(payload, prefix.byteLength);
  return signingInput;
}

function requireEd25519VerificationKey(publicKey: CryptoKey): CryptoKey {
  if (
    !(publicKey instanceof CryptoKey) ||
    publicKey.type !== "public" ||
    publicKey.algorithm.name !== "Ed25519" ||
    !publicKey.usages.includes("verify")
  ) {
    fail("INVALID_KEY");
  }
  return publicKey;
}

/**
 * Verify the outer RPi5 delivery signature without acquiring evidence or opening any
 * host/runtime path. The caller must still atomically claim `replayKey` in a separately
 * reviewed replay store before trusting the payload, then parse the exact payload bytes
 * and pass the resulting object to `normalizeSanitizedProductionVisibility`.
 */
export async function verifyRpi5ObservationDeliverySignature(
  input: unknown,
  payloadInput: Uint8Array,
  publicKeyInput: CryptoKey,
  nowInput: string,
): Promise<VerifiedRpi5ObservationSignature> {
  const metadata = normalizeRpi5ObservationDeliveryMetadata(input, nowInput);
  const payload = requirePayloadBytes(payloadInput);
  const publicKey = requireEd25519VerificationKey(publicKeyInput);
  const signature = decodeEd25519Signature(metadata.signature);
  const signingInput = buildRpi5ObservationSigningInput(metadata, payload);

  let verified = false;
  try {
    verified = await crypto.subtle.verify("Ed25519", publicKey, signature, signingInput);
  } catch {
    fail("INVALID_SIGNATURE");
  }
  if (!verified) fail("INVALID_SIGNATURE");

  return {
    metadata,
    replayKey: `${metadata.keyId}:${metadata.deliveryId}`,
    replayExpiresAt: new Date(
      Date.parse(metadata.sentAt) + MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS,
    ).toISOString(),
  };
}
