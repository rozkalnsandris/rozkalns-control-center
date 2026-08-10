import assert from "node:assert/strict";
import test from "node:test";

import { BOOTSTRAP_PHASE, SERVICE_NAME, buildHealthPayload } from "../src/shared/health.js";

test("health payload is deterministic and contains no mutable runtime state", () => {
  assert.deepEqual(buildHealthPayload(), {
    status: "ok",
    service: SERVICE_NAME,
    phase: BOOTSTRAP_PHASE
  });
});
