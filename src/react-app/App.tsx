import { useEffect, useState } from "react";

import { controlFixtures } from "../shared/control-fixtures";
import {
  decisionsForState,
  projectById,
  summarizeDashboard,
  type ControlDashboardData,
  type DecisionReadModel,
  type MockAction,
  type ProjectReadModel,
} from "../shared/control-model";
import type { HealthPayload } from "../shared/health";
import { DecisionCard } from "./components/DecisionCard";
import { StatusPill } from "./components/StatusPill";

type LiveDashboardState = "LOADING" | "LIVE" | "DISABLED" | "ERROR";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlDashboardData(value: unknown): value is ControlDashboardData {
  if (!isRecord(value) || typeof value.generatedAt !== "string") return false;
  if (!Array.isArray(value.projects) || !Array.isArray(value.decisions)) return false;

  const projectsValid = value.projects.every((project) => {
    if (!isRecord(project)) return false;
    return (
      typeof project.id === "string" &&
      typeof project.displayName === "string" &&
      typeof project.repository === "string" &&
      typeof project.enabled === "boolean" &&
      (project.productionAdapter === "none" || project.productionAdapter === "rpi5") &&
      (project.status === "HEALTHY" || project.status === "ATTENTION" || project.status === "WAITING") &&
      Number.isSafeInteger(project.openPullRequests) &&
      Number.isSafeInteger(project.openIssues)
    );
  });
  if (!projectsValid) return false;

  const validWorkflowStates = new Set(["NEEDS_ANDRIS", "WORKING", "WAITING", "CI_FAILED", "MERGE_READY", "DONE"]);
  const validCiStates = new Set(["PASS", "FAIL", "RUNNING", "WAITING"]);
  const validReviewStates = new Set(["PASS", "CHANGES_REQUESTED", "PENDING", "NOT_REQUIRED"]);
  const validDeployImpacts = new Set([
    "NO_DEPLOY",
    "AUTO_DEPLOY_SAFE",
    "MANUAL_ROLLOUT_REQUIRED",
    "DB_HOST_APPLY_REQUIRED",
    "UNKNOWN",
  ]);
  const validActions = new Set(["MERGE", "NEEDS_CHANGES", "LATER", "OPEN_PR"]);

  return value.decisions.every((decision) => {
    if (!isRecord(decision)) return false;
    const issueNumberValid = decision.issueNumber === null || Number.isSafeInteger(decision.issueNumber);
    const issueTitleValid = decision.issueTitle === null || typeof decision.issueTitle === "string";
    const prNumberValid = decision.prNumber === null || Number.isSafeInteger(decision.prNumber);
    const prTitleValid = decision.prTitle === null || typeof decision.prTitle === "string";
    const prUrlValid = decision.prUrl === undefined || decision.prUrl === null || typeof decision.prUrl === "string";
    const expectedHeadValid = decision.expectedHeadSha === null || typeof decision.expectedHeadSha === "string";
    const currentHeadValid = decision.currentHeadSha === null || typeof decision.currentHeadSha === "string";

    return (
      typeof decision.id === "string" &&
      typeof decision.projectId === "string" &&
      validWorkflowStates.has(String(decision.workflowState)) &&
      issueNumberValid &&
      issueTitleValid &&
      prNumberValid &&
      prTitleValid &&
      prUrlValid &&
      validCiStates.has(String(decision.ci)) &&
      validReviewStates.has(String(decision.review)) &&
      validDeployImpacts.has(String(decision.deployImpact)) &&
      Number.isSafeInteger(decision.changedFiles) &&
      expectedHeadValid &&
      currentHeadValid &&
      typeof decision.mainSha === "string" &&
      typeof decision.reason === "string" &&
      typeof decision.lastReconciledAt === "string" &&
      Array.isArray(decision.allowedActions) &&
      decision.allowedActions.every((action) => validActions.has(String(action)))
    );
  });
}

function projectTone(status: ProjectReadModel["status"]) {
  if (status === "HEALTHY") return "good" as const;
  if (status === "ATTENTION") return "warning" as const;
  return "info" as const;
}

const mockActionLabels: Record<MockAction, string> = {
  MERGE: "Merge",
  NEEDS_CHANGES: "Needs changes",
  LATER: "Later",
  OPEN_PR: "Open PR",
};

export default function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [liveDashboard, setLiveDashboard] = useState<ControlDashboardData | null>(null);
  const [liveState, setLiveState] = useState<LiveDashboardState>("LOADING");
  const [notice, setNotice] = useState("No GitHub action can execute");

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Health request failed: ${response.status}`);
        return response.json() as Promise<HealthPayload>;
      })
      .then((payload) => setHealth(payload))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setUnavailable(true);
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;

    void fetch("/api/github/dashboard", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (response.status === 503 && isRecord(payload) && payload.error === "LIVE_READ_DISABLED") {
          if (!ignore) setLiveState("DISABLED");
          return;
        }
        if (!response.ok || !isControlDashboardData(payload)) {
          throw new Error("Live dashboard response failed validation");
        }
        if (!ignore) {
          setLiveDashboard(payload);
          setLiveState("LIVE");
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!ignore) setLiveState("ERROR");
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, []);

  const dashboard = liveDashboard ?? controlFixtures;
  const live = liveState === "LIVE" && liveDashboard !== null;
  const summary = summarizeDashboard(dashboard);
  const needsAndris = decisionsForState(dashboard, "NEEDS_ANDRIS");
  const workingOrWaiting = decisionsForState(dashboard, "WORKING", "WAITING");
  const ciFailed = decisionsForState(dashboard, "CI_FAILED");
  const mergeReady = decisionsForState(dashboard, "MERGE_READY");

  function handleMockAction(action: MockAction, item: DecisionReadModel) {
    setNotice(`${mockActionLabels[action]} selected for fixture ${item.id} · demo only`);
  }

  const workerLabel = health?.status === "ok" ? "Worker ready" : unavailable ? "Worker unavailable" : "Worker checking";
  const modeLabel = live ? "LIVE READ-ONLY" : "FIXTURE MODE";
  const modeStatus = live
    ? "Live GitHub read-only"
    : liveState === "ERROR"
      ? "Live data unavailable · fixture data shown"
      : liveState === "LOADING"
        ? "Checking live GitHub data"
        : "Fixture mode";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>

      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">RC</div>
        <div className="brand-copy">
          <p>Rozkalns Control</p>
          <span>Decision control</span>
        </div>
        <StatusPill label={modeLabel} tone="info" />
      </header>

      <main id="main-content" className="dashboard">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">{live ? "Phase 2 · Live read-only" : "Phase 1 · Read-only prototype"}</p>
            <h1 id="page-title">Current repository control state</h1>
            <p className="summary">
              {live
                ? "Needs Andris is reserved for genuine owner-action gates. Everything else below is live GitHub read-only state; this screen cannot change GitHub, Cloudflare or RPi5."
                : "Needs Andris is reserved for genuine owner-action gates. Demo data only; this screen cannot change GitHub, Cloudflare or RPi5."}
            </p>
          </div>
        </section>

        <div className="control-status-strip" role="status" aria-live="polite">
          <span className="control-status-strip__health">
            <span className="system-dot" aria-hidden="true" />
            {workerLabel}
          </span>
          <span className="control-status-strip__separator" aria-hidden="true">·</span>
          <span>{modeStatus}</span>
          <span className="control-status-strip__separator" aria-hidden="true">·</span>
          <span className="control-status-strip__notice">{notice}</span>
        </div>

        <section className="summary-strip" aria-label="Control summary">
          <div className="summary-metric summary-metric--attention">
            <span>{summary.needsAndris}</span>
            <p>Needs Andris</p>
          </div>
          <div className="summary-metric">
            <span>{summary.workingOrWaiting}</span>
            <p>Working / waiting</p>
          </div>
          <div className="summary-metric summary-metric--danger">
            <span>{summary.ciFailed}</span>
            <p>CI failed</p>
          </div>
          <div className="summary-metric">
            <span>{summary.enabledProjects}</span>
            <p>Projects</p>
          </div>
        </section>

        <section className="dashboard-section dashboard-section--primary" aria-labelledby="needs-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Human gate</p>
              <h2 id="needs-title">Needs Andris</h2>
            </div>
            <span className="section-count">{needsAndris.length}</span>
          </div>
          {needsAndris.length > 0 ? (
            <div className="decision-list">
              {needsAndris.map((item) => (
                <DecisionCard key={item.id} item={item} project={projectById(dashboard, item.projectId)} onMockAction={handleMockAction} />
              ))}
            </div>
          ) : (
            <p className="section-empty-state">No owner action is required right now.</p>
          )}
        </section>

        <section className="dashboard-section" aria-labelledby="active-title">
          <div className="section-heading">
            <div><p className="eyebrow">No action needed</p><h2 id="active-title">Working / Waiting</h2></div>
            <span className="section-count">{workingOrWaiting.length}</span>
          </div>
          <div className="decision-list decision-list--compact">
            {workingOrWaiting.map((item) => (
              <DecisionCard key={item.id} item={item} project={projectById(dashboard, item.projectId)} onMockAction={handleMockAction} />
            ))}
          </div>
        </section>

        <section className="dashboard-section" aria-labelledby="failed-title">
          <div className="section-heading">
            <div><p className="eyebrow">Blocked</p><h2 id="failed-title">CI Failed</h2></div>
            <span className="section-count section-count--danger">{ciFailed.length}</span>
          </div>
          <div className="decision-list decision-list--compact">
            {ciFailed.map((item) => (
              <DecisionCard key={item.id} item={item} project={projectById(dashboard, item.projectId)} onMockAction={handleMockAction} />
            ))}
          </div>
        </section>

        <section className="dashboard-section" aria-labelledby="ready-title">
          <div className="section-heading">
            <div><p className="eyebrow">Visible, not selected</p><h2 id="ready-title">Merge Ready</h2></div>
            <span className="section-count">{mergeReady.length}</span>
          </div>
          <div className="decision-list decision-list--compact">
            {mergeReady.map((item) => (
              <DecisionCard key={item.id} item={item} project={projectById(dashboard, item.projectId)} onMockAction={handleMockAction} />
            ))}
          </div>
        </section>

        <section className="dashboard-section" aria-labelledby="projects-title">
          <div className="section-heading">
            <div><p className="eyebrow">Configured scope</p><h2 id="projects-title">Projects</h2></div>
            <span className="section-count">{summary.enabledProjects}</span>
          </div>

          <div className="project-grid">
            {dashboard.projects.map((project) => (
              <article className="project-card" key={project.id}>
                <div className="project-card__header">
                  <div><h3>{project.displayName}</h3><p>{project.repository}</p></div>
                  <StatusPill label={project.status} tone={projectTone(project.status)} />
                </div>
                <dl className="project-card__stats">
                  <div><dt>PRs</dt><dd>{project.openPullRequests}</dd></div>
                  <div><dt>Issues</dt><dd>{project.openIssues}</dd></div>
                  <div><dt>Production</dt><dd>{project.productionAdapter === "rpi5" ? "RPi5" : "None"}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </section>

        <footer className="prototype-footer">
          <p>{live ? "Live snapshot" : "Fixture snapshot"}: {dashboard.generatedAt.replace("T", " ").replace("Z", " UTC")}</p>
          <p>{live ? "Phase 2 · GitHub read-only · No deployment controls" : "Phase 1 · No live GitHub integration · No deployment controls"}</p>
        </footer>
      </main>
    </div>
  );
}
