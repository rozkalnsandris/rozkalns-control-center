export const CONTROL_READ_TIMEOUT_MS = 8_000;
export const MAX_CONTROL_READ_TIMEOUT_MS = 30_000;

export type ControlReadPath =
  | "/api/health"
  | "/api/github/dashboard"
  | "/api/github/webhook-deliveries";

export type ControlReadFailureCode =
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER"
  | "INVALID_JSON"
  | "INVALID_SCHEMA";

export class ControlReadError extends Error {
  readonly code: ControlReadFailureCode;
  readonly status: number | null;
  readonly payload: unknown;

  constructor(code: ControlReadFailureCode, options: { status?: number; payload?: unknown } = {}) {
    super(`Control read failed: ${code}`);
    this.name = "ControlReadError";
    this.code = code;
    this.status = options.status ?? null;
    this.payload = options.payload;
  }
}

export interface ControlReadOptions<T> {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly validate: (payload: unknown) => payload is T;
  readonly fetchRequest?: typeof fetch;
}

function requireTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_CONTROL_READ_TIMEOUT_MS) {
    throw new RangeError("Control read timeout is outside the bounded policy");
  }
  return timeoutMs;
}

/** Bounded same-origin GET helper. It is intentionally unavailable to mutation requests. */
export async function readControlJson<T>(
  path: ControlReadPath,
  options: ControlReadOptions<T>,
): Promise<T> {
  const timeoutMs = requireTimeout(options.timeoutMs ?? CONTROL_READ_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = options.signal?.aborted ?? false;

  const abortFromCaller = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (externallyAborted) throw new ControlReadError("ABORTED");
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await (options.fetchRequest ?? fetch)(path, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) {
        throw new ControlReadError("SERVER", { status: response.status });
      }
      throw new ControlReadError("INVALID_JSON", { status: response.status });
    }

    if (!response.ok) {
      throw new ControlReadError("SERVER", { status: response.status, payload });
    }
    if (!options.validate(payload)) {
      throw new ControlReadError("INVALID_SCHEMA", { status: response.status });
    }
    return payload;
  } catch (error: unknown) {
    if (error instanceof ControlReadError) throw error;
    if (timedOut) throw new ControlReadError("TIMEOUT");
    if (externallyAborted) throw new ControlReadError("ABORTED");
    throw new ControlReadError("NETWORK");
  } finally {
    globalThis.clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function isAbortedControlRead(error: unknown): boolean {
  return error instanceof ControlReadError && error.code === "ABORTED";
}
