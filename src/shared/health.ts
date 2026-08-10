export const SERVICE_NAME = "rozkalns-control" as const;
export const BOOTSTRAP_PHASE = "phase-0" as const;

export type HealthPayload = {
  status: "ok";
  service: typeof SERVICE_NAME;
  phase: typeof BOOTSTRAP_PHASE;
};

export function buildHealthPayload(): HealthPayload {
  return {
    status: "ok",
    service: SERVICE_NAME,
    phase: BOOTSTRAP_PHASE
  };
}
