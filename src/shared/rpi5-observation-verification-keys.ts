export const RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION =
  "control-phase5-rpi5-verification-keys-v1" as const;
export const MAX_RPI5_OBSERVATION_VERIFICATION_KEYS = 4;

export interface Rpi5ObservationVerificationKeyEntry {
  readonly keyId: string;
  readonly publicKeyBase64url: string;
}

export interface Rpi5ObservationVerificationKeyRegistry {
  readonly version: typeof RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION;
  readonly keys: readonly Rpi5ObservationVerificationKeyEntry[];
}

export type Rpi5ObservationVerificationKeyRegistryErrorCode =
  | "INVALID_REGISTRY"
  | "UNKNOWN_KEY_ID"
  | "INVALID_PUBLIC_KEY";

export class Rpi5ObservationVerificationKeyRegistryError extends Error {
  readonly code: Rpi5ObservationVerificationKeyRegistryErrorCode;

  constructor(code: Rpi5ObservationVerificationKeyRegistryErrorCode) {
    super("RPi5 observation verification-key registry failed closed");
    this.name = "Rpi5ObservationVerificationKeyRegistryError";
    this.code = code;
  }
}

const REGISTRY_FIELDS = ["version", "keys"] as const;
const REGISTRY_FIELD_SET = new Set<string>(REGISTRY_FIELDS);
const ENTRY_FIELDS = ["keyId", "publicKeyBase64url"] as const;
const ENTRY_FIELD_SET = new Set<string>(ENTRY_FIELDS);
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ED25519_RAW_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function fail(code: Rpi5ObservationVerificationKeyRegistryErrorCode): never {
  throw new Rpi5ObservationVerificationKeyRegistryError(code);
}

function requirePlainRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_REGISTRY");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_REGISTRY");
  return input as Record<string, unknown>;
}

function requireExactFields(
  input: object,
  record: Record<string, unknown>,
  requiredFields: readonly string[],
  allowedFields: ReadonlySet<string>,
): void {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedFields.has(key)) fail("INVALID_REGISTRY");
  }
  for (const key of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) fail("INVALID_REGISTRY");
  }
}

function decodeRawEd25519PublicKey(value: unknown): Uint8Array {
  if (typeof value !== "string" || !ED25519_RAW_PUBLIC_KEY_PATTERN.test(value)) {
    fail("INVALID_PUBLIC_KEY");
  }

  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/") }=`;
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    fail("INVALID_PUBLIC_KEY");
  }
  if (binary.length !== 32) fail("INVALID_PUBLIC_KEY");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function normalizeRpi5ObservationVerificationKeyRegistry(
  input: unknown,
): Rpi5ObservationVerificationKeyRegistry {
  const record = requirePlainRecord(input);
  requireExactFields(input as object, record, REGISTRY_FIELDS, REGISTRY_FIELD_SET);

  if (record.version !== RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION) {
    fail("INVALID_REGISTRY");
  }
  if (
    !Array.isArray(record.keys) ||
    record.keys.length === 0 ||
    record.keys.length > MAX_RPI5_OBSERVATION_VERIFICATION_KEYS
  ) {
    fail("INVALID_REGISTRY");
  }

  const seenKeyIds = new Set<string>();
  const keys = record.keys.map((inputEntry): Rpi5ObservationVerificationKeyEntry => {
    const entry = requirePlainRecord(inputEntry);
    requireExactFields(inputEntry as object, entry, ENTRY_FIELDS, ENTRY_FIELD_SET);

    if (typeof entry.keyId !== "string" || !KEY_ID_PATTERN.test(entry.keyId)) {
      fail("INVALID_REGISTRY");
    }
    if (seenKeyIds.has(entry.keyId)) fail("INVALID_REGISTRY");
    seenKeyIds.add(entry.keyId);

    if (typeof entry.publicKeyBase64url !== "string") fail("INVALID_PUBLIC_KEY");
    decodeRawEd25519PublicKey(entry.publicKeyBase64url);

    return {
      keyId: entry.keyId,
      publicKeyBase64url: entry.publicKeyBase64url,
    };
  });

  return {
    version: RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION,
    keys,
  };
}

export async function resolveRpi5ObservationVerificationKey(
  registryInput: unknown,
  keyIdInput: unknown,
): Promise<CryptoKey> {
  const registry = normalizeRpi5ObservationVerificationKeyRegistry(registryInput);
  if (typeof keyIdInput !== "string" || !KEY_ID_PATTERN.test(keyIdInput)) {
    fail("UNKNOWN_KEY_ID");
  }

  const selected = registry.keys.find((entry) => entry.keyId === keyIdInput);
  if (!selected) fail("UNKNOWN_KEY_ID");

  const rawPublicKey = decodeRawEd25519PublicKey(selected.publicKeyBase64url);
  try {
    return await crypto.subtle.importKey(
      "raw",
      copyToArrayBuffer(rawPublicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    fail("INVALID_PUBLIC_KEY");
  }
}
