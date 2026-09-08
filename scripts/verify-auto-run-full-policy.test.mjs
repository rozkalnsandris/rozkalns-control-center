import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateAutoRunFullPolicy } from "./verify-auto-run-full-policy.mjs";

function readCanonicalPolicy() {
  return JSON.parse(readFileSync(".github/auto-run-full-v2.json", "utf8"));
}

function expectInvalid(mutator, pattern) {
  const policy = readCanonicalPolicy();
  mutator(policy);
  assert.throws(() => validateAutoRunFullPolicy(policy), pattern);
}

test("canonical AUTO-RUN FULL policy passes strict validation", () => {
  const policy = readCanonicalPolicy();
  assert.equal(validateAutoRunFullPolicy(policy), policy);
});

test("missing required nested field fails closed", () => {
  expectInvalid(
    (policy) => {
      delete policy.merge.direct_merge_requires_expected_head_sha;
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$\.merge: missing required fields: direct_merge_requires_expected_head_sha/,
  );
});

test("unknown top-level and nested fields fail closed", () => {
  expectInvalid(
    (policy) => {
      policy.unexpected_authority = true;
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$: unknown fields: unexpected_authority/,
  );

  expectInvalid(
    (policy) => {
      policy.live.unexpected_live_authority = true;
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$\.live: unknown fields: unexpected_live_authority/,
  );
});

test("wrong primitive type fails closed", () => {
  expectInvalid(
    (policy) => {
      policy.controller_issue = "499";
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$\.controller_issue:/,
  );
});

test("unsupported constant or enum value fails closed", () => {
  expectInvalid(
    (policy) => {
      policy.merge.strategy = "HYBRID_EXACT_HEAD_V3";
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$\.merge\.strategy:/,
  );

  expectInvalid(
    (policy) => {
      policy.states[0] = "UNBOUNDED";
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$\.states:/,
  );
});

test("required safety sets reject omissions, additions and duplicates", () => {
  expectInvalid(
    (policy) => {
      policy.strict_live_never_implied.pop();
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$\.strict_live_never_implied: missing required items:/,
  );

  expectInvalid(
    (policy) => {
      policy.allowed_without_further_owner_nudge.push("FORCE_MERGE");
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$\.allowed_without_further_owner_nudge: unknown items: FORCE_MERGE/,
  );

  expectInvalid(
    (policy) => {
      policy.activation.activation_must_freeze.push("repository");
    },
    /AUTO_RUN_FULL_POLICY_INVALID \$\.activation\.activation_must_freeze: duplicate array item/,
  );
});

test("cross-field platform limits cannot silently diverge", () => {
  expectInvalid(
    (policy) => {
      policy.platform_constraints.event_triggered_tasks_max_runs_per_hour += 1;
    },
    /must equal execution_model\.event_triggered_task_max_runs_per_hour/,
  );
});
