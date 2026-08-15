const encoder = new TextEncoder();
const decoder = new TextDecoder();
const signaturePattern = /^sha256=([0-9a-f]{64})$/i;
const headerValuePattern = /^[A-Za-z0-9._:/+-]{1,200}$/;
const MAX_WEBHOOK_ACTION_LENGTH = 100;

export interface GitHubWebhookHeaders {
  signature: string;
  deliveryId: string;
  eventName: string;
}

const verifiedWebhookMarker: unique symbol = Symbol("verified-github-webhook");

export interface VerifiedGitHubWebhook {
  deliveryId: string;
  eventName: string;
  repository: string;
  action: string | null;
  readonly [verifiedWebhookMarker]: true;
}

export type AuthenticatedGitHubWebhookRequest =
  | {
      readonly kind: "PING";
      readonly deliveryId: string;
      readonly eventName: "ping";
    }
  | {
      readonly kind: "REPOSITORY_EVENT";
      readonly webhook: VerifiedGitHubWebhook;
    };

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

function payloadText(payload: string | Uint8Array): string {
  return typeof payload === "string" ? payload : decoder.decode(payload);
}

function verifiedPayloadObject(payload: string | Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText(payload));
  } catch {
    throw new InvalidWebhookError("Verified GitHub webhook payload must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidWebhookError("Verified GitHub webhook payload must be an object");
  }

  return parsed as Record<string, unknown>;
}

function repositoryFromVerifiedPayload(payload: Record<string, unknown>): string {
  const repository = payload.repository;
  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    throw new InvalidWebhookError("Verified GitHub webhook payload is missing repository identity");
  }

  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== "string" || fullName.trim().length === 0) {
    throw new InvalidWebhookError("Verified GitHub webhook repository.full_name must be a non-empty string");
  }

  return fullName;
}

function actionFromVerifiedPayload(payload: Record<string, unknown>): string | null {
  const action = payload.action;
  if (action === undefined || action === null) return null;
  if (typeof action !== "string" || action.length === 0 || action.length > MAX_WEBHOOK_ACTION_LENGTH) {
    throw new InvalidWebhookError("Verified GitHub webhook action must be a bounded non-empty string");
  }
  return action;
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

export async function authenticateGitHubWebhookRequest(
  payload: string | Uint8Array,
  headers: HeaderReader,
  secret: string,
): Promise<AuthenticatedGitHubWebhookRequest> {
  const parsed = readGitHubWebhookHeaders(headers);
  const verified = await verifyGitHubWebhookSignature(payload, parsed.signature, secret);
  if (!verified) throw new InvalidWebhookError("GitHub webhook signature verification failed");

  if (parsed.eventName === "ping") {
    return {
      kind: "PING",
      deliveryId: parsed.deliveryId,
      eventName: "ping",
    };
  }

  const verifiedPayload = verifiedPayloadObject(payload);
  return {
    kind: "REPOSITORY_EVENT",
    webhook: {
      deliveryId: parsed.deliveryId,
      eventName: parsed.eventName,
      repository: repositoryFromVerifiedPayload(verifiedPayload),
      action: actionFromVerifiedPayload(verifiedPayload),
      [verifiedWebhookMarker]: true,
    },
  };
}

export async function authenticateGitHubWebhook(
  payload: string | Uint8Array,
  headers: HeaderReader,
  secret: string,
): Promise<VerifiedGitHubWebhook> {
  const authenticated = await authenticateGitHubWebhookRequest(payload, headers, secret);
  if (authenticated.kind !== "REPOSITORY_EVENT") {
    throw new InvalidWebhookError("GitHub ping is not a repository webhook event");
  }
  return authenticated.webhook;
}
