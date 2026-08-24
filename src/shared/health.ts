export const SERVICE_NAME = "rozkalns-control" as const;
export const BOOTSTRAP_PHASE = "phase-0" as const;

export type HealthPayload = {
  status: "ok";
  service: typeof SERVICE_NAME;
  phase: typeof BOOTSTRAP_PHASE;
  workerVersion: string | null;
};

export function buildHealthPayload(
  workerVersion: string | null = null,
): HealthPayload {
  return {
    status: "ok",
    service: SERVICE_NAME,
    phase: BOOTSTRAP_PHASE,
    workerVersion,
  };
}
