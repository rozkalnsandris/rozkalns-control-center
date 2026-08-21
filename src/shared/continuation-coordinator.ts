import {
  readContinuationGithubSnapshot,
  type ContinuationGithubReadProvider,
  type ContinuationTaskBinding,
} from "./continuation-github-snapshot.js";
import {
  MAX_CONTINUATION_CANDIDATES,
  planDeterministicContinuation,
  type ContinuationCampaignSnapshot,
  type ContinuationPlanResult,
} from "./continuation-plan.js";

export interface ContinuationCoordinatorDependencies {
  readonly provider: ContinuationGithubReadProvider;
  readonly now: () => string;
}

export type ContinuationCoordinatorErrorCode =
  | "INVALID_INPUT"
  | "EXPECTED_MAIN_SHA_DRIFT"
  | "UNSUPPORTED_GATE_RESULT";

export class ContinuationCoordinatorError extends Error {
  readonly code: ContinuationCoordinatorErrorCode;

  constructor(code: ContinuationCoordinatorErrorCode) {
    super("Authoritative continuation coordination failed closed");
    this.name = "ContinuationCoordinatorError";
    this.code = code;
  }
}

function fail(code: ContinuationCoordinatorErrorCode): never {
  throw new ContinuationCoordinatorError(code);
}

function sealCampaign(input: ContinuationCampaignSnapshot): ContinuationCampaignSnapshot {
  if (!input || typeof input !== "object") fail("INVALID_INPUT");
  if (input.currentTask !== null && (!input.currentTask || typeof input.currentTask !== "object")) {
    fail("INVALID_INPUT");
  }

  return {
    schemaVersion: input.schemaVersion,
    campaignId: input.campaignId,
    projectId: input.projectId,
    repository: input.repository,
    continueEnabled: input.continueEnabled,
    paused: input.paused,
    currentTask:
      input.currentTask === null
        ? null
        : { taskId: input.currentTask.taskId, state: input.currentTask.state },
    humanGate: input.humanGate,
  };
}

function sealBindings(input: readonly ContinuationTaskBinding[]): ContinuationTaskBinding[] {
  if (!Array.isArray(input) || input.length > MAX_CONTINUATION_CANDIDATES) {
    fail("INVALID_INPUT");
  }

  return input.map((binding) => {
    if (!binding || typeof binding !== "object") fail("INVALID_INPUT");
    return {
      taskId: binding.taskId,
      projectId: binding.projectId,
      repository: binding.repository,
      issueNumber: binding.issueNumber,
      taskState: binding.taskState,
      activePullRequestNumber: binding.activePullRequestNumber,
      expectedHeadSha: binding.expectedHeadSha,
      priority: binding.priority,
    };
  });
}

/**
 * Coordinate one explicitly pinned read-only continuation observation.
 *
 * Owner/Pause gates return before the first provider call. An eligible campaign
 * receives one bounded GitHub observation only; stale expected main, drift or
 * expired evidence fail closed. READY remains planning evidence, never merge,
 * deploy, send, persistence, scheduling or other mutation authorization.
 */
export async function coordinateAuthoritativeContinuation(
  campaignInput: ContinuationCampaignSnapshot,
  taskBindingsInput: readonly ContinuationTaskBinding[],
  expectedMainSha: string,
  dependencies: ContinuationCoordinatorDependencies,
): Promise<ContinuationPlanResult> {
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    !dependencies.provider ||
    typeof dependencies.provider !== "object" ||
    typeof dependencies.now !== "function"
  ) {
    fail("INVALID_INPUT");
  }

  const campaign = sealCampaign(campaignInput);
  const bindings = sealBindings(taskBindingsInput);
  const observedAt = dependencies.now();

  const gate = planDeterministicContinuation(
    campaign,
    {
      schemaVersion: 1,
      repository: campaign.repository,
      mainSha: expectedMainSha,
      observedAt,
      candidates: [],
    },
    observedAt,
  );

  switch (gate.kind) {
    case "HUMAN_GATE":
    case "PAUSED":
    case "CONTINUATION_DISABLED":
    case "CURRENT_TASK_INCOMPLETE":
      return gate;
    case "NO_ELIGIBLE_TASK":
      break;
    default:
      fail("UNSUPPORTED_GATE_RESULT");
  }

  const snapshot = await readContinuationGithubSnapshot(
    dependencies.provider,
    campaign.repository,
    campaign.projectId,
    bindings,
    observedAt,
  );
  if (snapshot.mainSha !== expectedMainSha) fail("EXPECTED_MAIN_SHA_DRIFT");

  return planDeterministicContinuation(campaign, snapshot, dependencies.now());
}
