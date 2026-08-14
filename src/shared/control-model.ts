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
  issueNumber: number | null;
  issueTitle: string | null;
  prNumber: number | null;
  prTitle: string | null;
  prUrl?: string | null;
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

export interface ControlDashboardData {
  generatedAt: string;
  projects: ProjectReadModel[];
  decisions: DecisionReadModel[];
}

export type ControlFixtureSet = ControlDashboardData;

export interface DashboardSummary {
  needsAndris: number;
  workingOrWaiting: number;
  ciFailed: number;
  mergeReady: number;
  enabledProjects: number;
}

export function summarizeDashboard(data: ControlDashboardData): DashboardSummary {
  return {
    needsAndris: data.decisions.filter((item) => item.workflowState === "NEEDS_ANDRIS").length,
    workingOrWaiting: data.decisions.filter(
      (item) => item.workflowState === "WORKING" || item.workflowState === "WAITING",
    ).length,
    ciFailed: data.decisions.filter((item) => item.workflowState === "CI_FAILED").length,
    mergeReady: data.decisions.filter((item) => item.workflowState === "MERGE_READY").length,
    enabledProjects: data.projects.filter((project) => project.enabled).length,
  };
}

export function decisionsForState(
  data: ControlDashboardData,
  ...states: WorkflowState[]
): DecisionReadModel[] {
  const wanted = new Set(states);
  return data.decisions.filter((item) => wanted.has(item.workflowState));
}

export function projectById(data: ControlDashboardData, projectId: string): ProjectReadModel {
  const project = data.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}
