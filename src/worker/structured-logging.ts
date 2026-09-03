export type WorkerLogRoute =
  | "HEALTH"
  | "GITHUB_DASHBOARD"
  | "GITHUB_RECONCILE"
  | "GITHUB_NEEDS_CHANGES_PREFLIGHT"
  | "GITHUB_NEEDS_CHANGES"
  | "GITHUB_MERGE"
  | "GITHUB_LATER"
  | "GITHUB_WEBHOOK_DELIVERIES"
  | "GITHUB_WEBHOOK"
  | "NOT_FOUND"
  | "QUEUE_RECONCILIATION"
  | "QUEUE_DEAD_LETTER"
  | "QUEUE_UNKNOWN";

export type WorkerLogMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "QUEUE" | "OTHER";
export type WorkerLogOutcome = "SUCCESS" | "CLIENT_ERROR" | "SERVER_ERROR" | "FAILED";
export type WorkerLogErrorCode = "HTTP_CLIENT_ERROR" | "HTTP_SERVER_ERROR" | "UNCAUGHT_ERROR" | "QUEUE_PROCESSING_ERROR" | null;

export interface WorkerOperationLogRecord {
  readonly event: "control.worker.operation";
  readonly route: WorkerLogRoute;
  readonly method: WorkerLogMethod;
  readonly status: number | null;
  readonly outcome: WorkerLogOutcome;
  readonly errorCode: WorkerLogErrorCode;
  readonly durationMs: number;
  readonly workerVersion: string | null;
  readonly correlationId: string | null;
  readonly messageCount: number | null;
}

export interface WorkerLoggingOptions {
  readonly nowMs?: () => number;
  readonly sink?: (record: WorkerOperationLogRecord) => void;
}

export interface WorkerQueueLogInput {
  readonly queue: string;
  readonly messages: readonly unknown[];
}

const REQUEST_ROUTES = new Map<string, WorkerLogRoute>([
  ["/api/health", "HEALTH"],
  ["/api/github/dashboard", "GITHUB_DASHBOARD"],
  ["/api/github/reconcile", "GITHUB_RECONCILE"],
  ["/api/github/needs-changes/preflight", "GITHUB_NEEDS_CHANGES_PREFLIGHT"],
  ["/api/github/needs-changes", "GITHUB_NEEDS_CHANGES"],
  ["/api/github/merge", "GITHUB_MERGE"],
  ["/api/github/later", "GITHUB_LATER"],
  ["/api/github/webhook-deliveries", "GITHUB_WEBHOOK_DELIVERIES"],
  ["/api/github/webhook", "GITHUB_WEBHOOK"],
]);
const SAFE_METHODS = new Set<WorkerLogMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const CF_RAY_PATTERN = /^[a-fA-F0-9]{16,32}(?:-[A-Z]{3})?$/;
const RECONCILIATION_QUEUE = "rozkalns-control-reconciliation";
const RECONCILIATION_DLQ = "rozkalns-control-reconciliation-dlq";
const MAX_LOGGED_DURATION_MS = 24 * 60 * 60 * 1000;

function defaultSink(record: WorkerOperationLogRecord): void {
  console.log(record);
}

function emit(record: WorkerOperationLogRecord, sink = defaultSink): void {
  try {
    sink(record);
  } catch {
    // Telemetry must never alter request or Queue behavior.
  }
}

function safeWorkerVersion(value: unknown): string | null {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value) ? value : null;
}

function safeCorrelationId(request: Request): string | null {
  const value = request.headers.get("cf-ray");
  return value && CF_RAY_PATTERN.test(value) ? value : null;
}

function safeMethod(value: string): WorkerLogMethod {
  return SAFE_METHODS.has(value as WorkerLogMethod) ? value as WorkerLogMethod : "OTHER";
}

function requestRoute(request: Request): WorkerLogRoute {
  const pathname = new URL(request.url).pathname;
  return REQUEST_ROUTES.get(pathname) ?? "NOT_FOUND";
}

function queueRoute(queue: string): WorkerLogRoute {
  if (queue === RECONCILIATION_QUEUE) return "QUEUE_RECONCILIATION";
  if (queue === RECONCILIATION_DLQ) return "QUEUE_DEAD_LETTER";
  return "QUEUE_UNKNOWN";
}

function duration(startedAt: number, finishedAt: number): number {
  const elapsed = Math.round(finishedAt - startedAt);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) return 0;
  return Math.min(elapsed, MAX_LOGGED_DURATION_MS);
}

function responseOutcome(status: number): Pick<WorkerOperationLogRecord, "outcome" | "errorCode"> {
  if (status >= 500) return { outcome: "SERVER_ERROR", errorCode: "HTTP_SERVER_ERROR" };
  if (status >= 400) return { outcome: "CLIENT_ERROR", errorCode: "HTTP_CLIENT_ERROR" };
  return { outcome: "SUCCESS", errorCode: null };
}

/**
 * Emit one fixed-shape request event. The boundary never reads a request body,
 * response body, cookie, authorization material, or URL query values.
 */
export async function withWorkerRequestLogging(
  request: Request,
  workerVersion: unknown,
  operation: () => Promise<Response>,
  options: WorkerLoggingOptions = {},
): Promise<Response> {
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();
  const base = {
    event: "control.worker.operation" as const,
    route: requestRoute(request),
    method: safeMethod(request.method),
    workerVersion: safeWorkerVersion(workerVersion),
    correlationId: safeCorrelationId(request),
    messageCount: null,
  };

  try {
    const response = await operation();
    emit({
      ...base,
      status: response.status,
      ...responseOutcome(response.status),
      durationMs: duration(startedAt, nowMs()),
    }, options.sink);
    return response;
  } catch (error: unknown) {
    emit({
      ...base,
      status: null,
      outcome: "FAILED",
      errorCode: "UNCAUGHT_ERROR",
      durationMs: duration(startedAt, nowMs()),
    }, options.sink);
    throw error;
  }
}

/** Emit one fixed-shape Queue event without inspecting any message body. */
export async function withWorkerQueueLogging(
  batch: WorkerQueueLogInput,
  workerVersion: unknown,
  operation: () => Promise<void>,
  options: WorkerLoggingOptions = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();
  const messageCount = Number.isSafeInteger(batch.messages.length) ? batch.messages.length : 0;
  const base = {
    event: "control.worker.operation" as const,
    route: queueRoute(batch.queue),
    method: "QUEUE" as const,
    status: null,
    workerVersion: safeWorkerVersion(workerVersion),
    correlationId: null,
    messageCount,
  };

  try {
    await operation();
    emit({
      ...base,
      outcome: "SUCCESS",
      errorCode: null,
      durationMs: duration(startedAt, nowMs()),
    }, options.sink);
  } catch (error: unknown) {
    emit({
      ...base,
      outcome: "FAILED",
      errorCode: "QUEUE_PROCESSING_ERROR",
      durationMs: duration(startedAt, nowMs()),
    }, options.sink);
    throw error;
  }
}
