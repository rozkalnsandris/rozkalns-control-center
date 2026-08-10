const encoder = new TextEncoder();
const signaturePattern = /^sha256=([0-9a-f]{64})$/i;
const headerValuePattern = /^[A-Za-z0-9._:/+-]{1,200}$/;

export interface GitHubWebhookHeaders {
  signature: string;
  deliveryId: string;
  eventName: string;
}

const verifiedWebhookMarker: unique symbol = Symbol("verified-github-webhook");

export interface VerifiedGitHubWebhook {
  deliveryId: string;
  eventName: string;
  readonly [verifiedWebhookMarker]: true;
}

export class InvalidWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWebhookError";
  }
}

export interface HeaderReader {
  get(name: string): string | null;
}

function requireHeader(headers: HeaderReader, name: string) {
  const value = headers.get(name)?.trim();
  if (!value) throw new InvalidWebhookError(`Missing required GitHub webhook header: ${name}`);
  return value;
}

function validateOpaqueHeader(value: string, name: string) {
  if (!headerValuePattern.test(value)) {
    throw new InvalidWebhookError(`Malformed GitHub webhook header: ${name}`);
  }
  return value;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function payloadArrayBuffer(payload: string | Uint8Array): ArrayBuffer {
  return copyToArrayBuffer(typeof payload === "string" ? encoder.encode(payload) : payload);
}

export function readGitHubWebhookHeaders(headers: HeaderReader): GitHubWebhookHeaders {
  const signature = requireHeader(headers, "x-hub-signature-256");
  if (!signaturePattern.test(signature)) {
    throw new InvalidWebhookError("Malformed x-hub-signature-256 header");
  }

  return {
    signature,
    deliveryId: validateOpaqueHeader(requireHeader(headers, "x-github-delivery"), "x-github-delivery"),
    eventName: validateOpaqueHeader(requireHeader(headers, "x-github-event"), "x-github-event"),
  };
}

export async function verifyGitHubWebhookSignature(
  payload: string | Uint8Array,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!secret) throw new InvalidWebhookError("Webhook secret is required");

  const match = signaturePattern.exec(signatureHeader);
  if (!match) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    copyToArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    hexToArrayBuffer(match[1]),
    payloadArrayBuffer(payload),
  );
}

export async function authenticateGitHubWebhook(
  payload: string | Uint8Array,
  headers: HeaderReader,
  secret: string,
): Promise<VerifiedGitHubWebhook> {
  const parsed = readGitHubWebhookHeaders(headers);
  const verified = await verifyGitHubWebhookSignature(payload, parsed.signature, secret);
  if (!verified) throw new InvalidWebhookError("GitHub webhook signature verification failed");

  return {
    deliveryId: parsed.deliveryId,
    eventName: parsed.eventName,
    [verifiedWebhookMarker]: true,
  };
}
