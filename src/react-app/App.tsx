import { useEffect, useState } from "react";

import { controlFixtures } from "../shared/control-fixtures";
import {
  decisionsForState,
  projectById,
  summarizeDashboard,
  type DecisionReadModel,
  type MockAction,
  type ProjectReadModel,
} from "../shared/control-model";
import type { HealthPayload } from "../shared/health";
import { DecisionCard } from "./components/DecisionCard";
import { StatusPill } from "./components/StatusPill";

const summary = summarizeDashboard(controlFixtures);
const needsAndris = decisionsForState(controlFixtures, "NEEDS_ANDRIS");
const workingOrWaiting = decisionsForState(controlFixtures, "WORKING", "WAITING");
const ciFailed = decisionsForState(controlFixtures, "CI_FAILED");
const mergeReady = decisionsForState(controlFixtures, "MERGE_READY");

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
  const [notice, setNotice] = useState("Fixture mode is active. No GitHub action can execute from this screen.");

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

  function handleMockAction(action: MockAction, item: DecisionReadModel) {
    setNotice(
      `${mockActionLabels[action]} selected for fixture ${item.id}. Phase 1 is read-only; nothing was sent to GitHub or production.`,
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>

      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">RC</div>
        <div className="brand-copy">
          <p>Rozkalns Control</p>
          <span>Mobile approval plane</span>
        </div>
        <StatusPill label="FIXTURE MODE" tone="info" />
      </header>

      <main id="main-content" className="dashboard">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Phase 1 · Read-only prototype</p>
            <h1 id="page-title">What needs your decision?</h1>
            <p className="summary">
              Human gates first. Everything below is deterministic demo data and cannot mutate GitHub, Cloudflare or RPi5.
            </p>
          </div>
          <div className="hero__system" aria-label="Prototype system status">
            <span className="system-dot" aria-hidden="true" />
            <span>
              Worker {health?.status === "ok" ? "ready" : unavailable ? "unavailable" : "checking"}
            </span>
          </div>
        </section>

        <div className="fixture-notice" role="status" aria-live="polite">
          <strong>Demo safety:</strong> {notice}
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
          <div className="decision-list">
            {needsAndris.map((item) => (
              <DecisionCard
                key={item.id}
                item={item}
                project={projectById(controlFixtures, item.projectId)}
                onMockAction={handleMockAction}
              />
            ))}
          </div>
        </section>

        <div className="secondary-grid">
          <section className="dashboard-section" aria-labelledby="active-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">No action needed</p>
                <h2 id="active-title">Working / Waiting</h2>
              </div>
              <span className="section-count">{workingOrWaiting.length}</span>
            </div>
            <div className="decision-list decision-list--compact">
              {workingOrWaiting.map((item) => (
                <DecisionCard
                  key={item.id}
                  item={item}
                  project={projectById(controlFixtures, item.projectId)}
                  onMockAction={handleMockAction}
                />
              ))}
            </div>
          </section>

          <section className="dashboard-section" aria-labelledby="failed-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Blocked</p>
                <h2 id="failed-title">CI Failed</h2>
              </div>
              <span className="section-count section-count--danger">{ciFailed.length}</span>
            </div>
            <div className="decision-list decision-list--compact">
              {ciFailed.map((item) => (
                <DecisionCard
                  key={item.id}
                  item={item}
                  project={projectById(controlFixtures, item.projectId)}
                  onMockAction={handleMockAction}
                />
              ))}
            </div>
          </section>
        </div>

        <section className="dashboard-section" aria-labelledby="ready-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Visible, not selected</p>
              <h2 id="ready-title">Merge Ready</h2>
            </div>
            <span className="section-count">{mergeReady.length}</span>
          </div>
          <div className="decision-list decision-list--compact">
            {mergeReady.map((item) => (
              <DecisionCard
                key={item.id}
                item={item}
                project={projectById(controlFixtures, item.projectId)}
                onMockAction={handleMockAction}
              />
            ))}
          </div>
        </section>

        <section className="dashboard-section" aria-labelledby="projects-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Configured scope</p>
              <h2 id="projects-title">Projects</h2>
            </div>
            <span className="section-count">{summary.enabledProjects}</span>
          </div>

          <div className="project-grid">
            {controlFixtures.projects.map((project) => (
              <article className="project-card" key={project.id}>
                <div className="project-card__header">
                  <div>
                    <h3>{project.displayName}</h3>
                    <p>{project.repository}</p>
                  </div>
                  <StatusPill label={project.status} tone={projectTone(project.status)} />
                </div>
                <dl className="project-card__stats">
                  <div>
                    <dt>PRs</dt>
                    <dd>{project.openPullRequests}</dd>
                  </div>
                  <div>
                    <dt>Issues</dt>
                    <dd>{project.openIssues}</dd>
                  </div>
                  <div>
                    <dt>Production</dt>
                    <dd>{project.productionAdapter === "rpi5" ? "RPi5" : "None"}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </section>

        <footer className="prototype-footer">
          <p>Fixture snapshot: {controlFixtures.generatedAt.replace("T", " ").replace("Z", " UTC")}</p>
          <p>Phase 1 · No live GitHub integration · No deployment controls</p>
        </footer>
      </main>
    </div>
  );
}
