import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOTSTRAP_PHASE,
  SERVICE_NAME,
  buildHealthPayload,
} from "../src/shared/health.js";

test("health payload contains the supplied Worker version deterministically", () => {
  assert.deepEqual(buildHealthPayload("candidate-version-id"), {
    status: "ok",
    service: SERVICE_NAME,
    phase: BOOTSTRAP_PHASE,
    workerVersion: "candidate-version-id",
  });
});

test("health payload uses null when no Worker version is supplied", () => {
  assert.deepEqual(buildHealthPayload(), {
    status: "ok",
    service: SERVICE_NAME,
    phase: BOOTSTRAP_PHASE,
    workerVersion: null,
  });
});
