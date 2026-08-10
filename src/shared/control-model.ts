export type WorkflowState =
  | "NEEDS_ANDRIS"
  | "WORKING"
  | "WAITING"
  | "CI_FAILED"
  | "MERGE_READY"
  | "DONE";

export type CiState = "PASS" | "FAIL" | "RUNNING" | "WAITING";
export type ReviewState = "PASS" | "CHANGES_REQUESTED" | "PENDING" | "NOT_REQUIRED";
export type DeployImpact =
  | "NO_DEPLOY"
  | "AUTO_DEPLOY_SAFE"
  | "MANUAL_ROLLOUT_REQUIRED"
  | "DB_HOST_APPLY_REQUIRED"
  | "UNKNOWN";

export type MockAction = "MERGE" | "NEEDS_CHANGES" | "LATER" | "OPEN_PR";

export interface ProjectReadModel {
  id: string;
  displayName: string;
  repository: string;
  enabled: boolean;
  productionAdapter: "none" | "rpi5";
  status: "HEALTHY" | "ATTENTION" | "WAITING";
  openPullRequests: number;
  openIssues: number;
}

export interface DecisionReadModel {
  id: string;
  projectId: string;
  workflowState: WorkflowState;
  issueNumber: number;
  issueTitle: string;
  prNumber: number | null;
  prTitle: string | null;
  ci: CiState;
  review: ReviewState;
  deployImpact: DeployImpact;
  changedFiles: number;
  expectedHeadSha: string | null;
  currentHeadSha: string | null;
  mainSha: string;
  reason: string;
  lastReconciledAt: string;
  allowedActions: MockAction[];
}

export interface ControlFixtureSet {
  generatedAt: string;
  projects: ProjectReadModel[];
  decisions: DecisionReadModel[];
}

export interface DashboardSummary {
  needsAndris: number;
  workingOrWaiting: number;
  ciFailed: number;
  mergeReady: number;
  enabledProjects: number;
}

export function summarizeDashboard(fixtures: ControlFixtureSet): DashboardSummary {
  return {
    needsAndris: fixtures.decisions.filter((item) => item.workflowState === "NEEDS_ANDRIS").length,
    workingOrWaiting: fixtures.decisions.filter(
      (item) => item.workflowState === "WORKING" || item.workflowState === "WAITING",
    ).length,
    ciFailed: fixtures.decisions.filter((item) => item.workflowState === "CI_FAILED").length,
    mergeReady: fixtures.decisions.filter((item) => item.workflowState === "MERGE_READY").length,
    enabledProjects: fixtures.projects.filter((project) => project.enabled).length,
  };
}

export function decisionsForState(
  fixtures: ControlFixtureSet,
  ...states: WorkflowState[]
): DecisionReadModel[] {
  const wanted = new Set(states);
  return fixtures.decisions.filter((item) => wanted.has(item.workflowState));
}

export function projectById(fixtures: ControlFixtureSet, projectId: string): ProjectReadModel {
  const project = fixtures.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Unknown project fixture: ${projectId}`);
  return project;
}
