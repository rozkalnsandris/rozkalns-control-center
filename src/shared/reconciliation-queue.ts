import type { GitHubReconciliationTrigger } from "./github-reconciliation.js";
import { requireManagedProjectPolicy } from "./project-policy.js";

export const RECONCILIATION_QUEUE_MESSAGE_VERSION = 1 as const;
export const RECONCILIATION_QUEUE_MESSAGE_KIND = "GITHUB_RECONCILIATION" as const;

export interface ReconciliationQueueMessageV1 {
  schemaVersion: typeof RECONCILIATION_QUEUE_MESSAGE_VERSION;
  kind: typeof RECONCILIATION_QUEUE_MESSAGE_KIND;
  deliveryId: string;
  eventName: string;
  repository: string;
  projectId: string;
  receivedAt: string;
  authoritativeReadRequired: true;
}

const allowedKeys = new Set<keyof ReconciliationQueueMessageV1>([
  "schemaVersion",
  "kind",
  "deliveryId",
  "eventName",
  "repository",
  "projectId",
  "receivedAt",
  "authoritativeReadRequired",
]);

const opaqueIdentifierPattern = /^[A-Za-z0-9._:/+-]{1,200}$/;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reconciliation queue message must be an object");
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function opaqueIdentifier(value: unknown, field: string): string {
  const parsed = nonEmptyString(value, field);
  if (!opaqueIdentifierPattern.test(parsed)) throw new Error(`${field} is malformed`);
  return parsed;
}

function utcTimestamp(value: unknown, field: string): string {
  const parsed = nonEmptyString(value, field);
  if (!utcTimestampPattern.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${field} must be a UTC ISO timestamp`);
  }
  return parsed;
}

export function createReconciliationQueueMessage(
  trigger: GitHubReconciliationTrigger,
): ReconciliationQueueMessageV1 {
  const project = requireManagedProjectPolicy(trigger.repository);
  if (project.id !== trigger.projectId) {
    throw new Error("Reconciliation trigger project does not match repository policy");
  }
  if (!trigger.authoritativeReadRequired) {
    throw new Error("Reconciliation queue messages must require an authoritative GitHub reread");
  }

  return {
    schemaVersion: RECONCILIATION_QUEUE_MESSAGE_VERSION,
    kind: RECONCILIATION_QUEUE_MESSAGE_KIND,
    deliveryId: opaqueIdentifier(trigger.deliveryId, "deliveryId"),
    eventName: opaqueIdentifier(trigger.eventName, "eventName"),
    repository: project.repository,
    projectId: project.id,
    receivedAt: utcTimestamp(trigger.receivedAt, "receivedAt"),
    authoritativeReadRequired: true,
  };
}

export function parseReconciliationQueueMessage(input: unknown): ReconciliationQueueMessageV1 {
  const message = record(input);

  for (const key of Object.keys(message)) {
    if (!allowedKeys.has(key as keyof ReconciliationQueueMessageV1)) {
      throw new Error(`Unsupported reconciliation queue message field: ${key}`);
    }
  }

  if (message.schemaVersion !== RECONCILIATION_QUEUE_MESSAGE_VERSION) {
    throw new Error("Unsupported reconciliation queue message schema version");
  }
  if (message.kind !== RECONCILIATION_QUEUE_MESSAGE_KIND) {
    throw new Error("Unsupported reconciliation queue message kind");
  }
  if (message.authoritativeReadRequired !== true) {
    throw new Error("Reconciliation queue message must require an authoritative GitHub reread");
  }

  const repository = nonEmptyString(message.repository, "repository");
  const project = requireManagedProjectPolicy(repository);
  const projectId = nonEmptyString(message.projectId, "projectId");
  if (project.id !== projectId) {
    throw new Error("Reconciliation queue message project does not match repository policy");
  }

  return {
    schemaVersion: RECONCILIATION_QUEUE_MESSAGE_VERSION,
    kind: RECONCILIATION_QUEUE_MESSAGE_KIND,
    deliveryId: opaqueIdentifier(message.deliveryId, "deliveryId"),
    eventName: opaqueIdentifier(message.eventName, "eventName"),
    repository: project.repository,
    projectId: project.id,
    receivedAt: utcTimestamp(message.receivedAt, "receivedAt"),
    authoritativeReadRequired: true,
  };
}
