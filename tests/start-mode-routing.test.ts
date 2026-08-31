import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type RoutingPolicy = {
  schema_version: number;
  repository: string;
  default_continuation_mode: string;
  lane_roles: Record<string, string>;
  explicit_modes: {
    "GITHUB-ONLY": {
      requires_explicit_current_command_token: boolean;
      may_be_inferred_from_context: boolean;
    };
    "LIVE-ALL": {
      requires_explicit_current_command_token: boolean;
      may_be_inferred_from_context: boolean;
    };
    "AUTO-RUN-FULL": {
      canonical_prefix: string;
      requires_explicit_current_command_token: boolean;
      requires_repository_argument: string;
      requires_issue_argument: boolean;
      issue_argument_pattern: string;
      policy: string;
      controller_issue: number;
      preferred_resume: string;
      fallback_resume: string;
      merge_strategy: string;
      may_be_inferred_from_context: boolean;
    };
  };
  bare_continuation_commands: string[];
  bare_continuation_result: string;
  forbidden_mode_inference_sources: string[];
};

function readRouting(): RoutingPolicy {
  return JSON.parse(
    readFileSync(".github/start-mode-routing.json", "utf8"),
  ) as RoutingPolicy;
}

test("bare START and turpini stay on FAST-LANE", () => {
  const routing = readRouting();

  assert.equal(routing.schema_version, 3);
  assert.equal(routing.repository, "rozkalnsandris/rozkalns-control-center");
  assert.equal(routing.default_continuation_mode, "FAST-LANE v2.2");
  assert.equal(routing.bare_continuation_result, "FAST-LANE v2.2");
  assert.ok(routing.bare_continuation_commands.includes("START"));
  assert.ok(routing.bare_continuation_commands.includes("START rozkalns-control-center"));
  assert.ok(routing.bare_continuation_commands.includes("turpini"));
  assert.equal(
    routing.lane_roles["FAST-LANE v2.2"],
    "SAFE_DISCOVERY_AUDIT_AND_NON_FULL_CONTINUATION",
  );
  assert.equal(
    routing.lane_roles["AUTO-RUN-FULL"],
    "NORMAL_ISSUE_SCOPED_IMPLEMENTATION",
  );
});

test("FULL requires the exact current command, repository and issue", () => {
  const routing = readRouting();
  const full = routing.explicit_modes["AUTO-RUN-FULL"];

  assert.equal(full.canonical_prefix, "AUTO-RUN FULL");
  assert.equal(full.requires_explicit_current_command_token, true);
  assert.equal(full.requires_repository_argument, "rozkalns-control-center");
  assert.equal(full.requires_issue_argument, true);
  assert.equal(full.issue_argument_pattern, "^#[1-9][0-9]*$");
  assert.equal(full.policy, ".github/auto-run-full-v2.json");
  assert.equal(full.controller_issue, 499);
  assert.equal(full.preferred_resume, "GITHUB_EVENT_TRIGGERED_WORK");
  assert.equal(full.fallback_resume, "HOURLY_SCHEDULED_WATCHDOG");
  assert.equal(full.merge_strategy, "HYBRID_EXACT_HEAD_V2");
  assert.equal(full.may_be_inferred_from_context, false);
});

test("existing explicit modes remain explicit and cannot bleed into FULL", () => {
  const routing = readRouting();

  assert.equal(
    routing.explicit_modes["GITHUB-ONLY"].requires_explicit_current_command_token,
    true,
  );
  assert.equal(routing.explicit_modes["GITHUB-ONLY"].may_be_inferred_from_context, false);
  assert.equal(
    routing.explicit_modes["LIVE-ALL"].requires_explicit_current_command_token,
    true,
  );
  assert.equal(routing.explicit_modes["LIVE-ALL"].may_be_inferred_from_context, false);

  for (const requiredSource of [
    "issue #278 operational continuity",
    "issue #497 night queue state",
    "prior live authorization",
    "prior FULL authorization receipt",
    "AUTO-RUN controller state without a fresh explicit activation command",
  ]) {
    assert.ok(routing.forbidden_mode_inference_sources.includes(requiredSource));
  }
});
