import type { DecisionReadModel, MockAction, ProjectReadModel } from "../../shared/control-model";
import { StatusPill } from "./StatusPill";

interface DecisionCardProps {
  item: DecisionReadModel;
  project: ProjectReadModel;
  onMockAction: (action: MockAction, item: DecisionReadModel) => void;
}

const actionLabels: Record<MockAction, string> = {
  MERGE: "Merge",
  NEEDS_CHANGES: "Needs changes",
  LATER: "Later",
  OPEN_PR: "Open PR",
};

function toneForCi(ci: DecisionReadModel["ci"]) {
  if (ci === "PASS") return "good" as const;
  if (ci === "FAIL") return "danger" as const;
  return "info" as const;
}

function toneForReview(review: DecisionReadModel["review"]) {
  if (review === "PASS") return "good" as const;
  if (review === "CHANGES_REQUESTED") return "danger" as const;
  if (review === "PENDING") return "warning" as const;
  return "neutral" as const;
}

function toneForDeploy(deploy: DecisionReadModel["deployImpact"]) {
  if (deploy === "NO_DEPLOY" || deploy === "AUTO_DEPLOY_SAFE") return "good" as const;
  if (deploy === "UNKNOWN") return "neutral" as const;
  return "warning" as const;
}

function shortSha(sha: string | null) {
  return sha ? sha.slice(0, 8) : "—";
}

function reconciledLabel(timestamp: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export function DecisionCard({ item, project, onMockAction }: DecisionCardProps) {
  const titleId = `${item.id}-title`;
  const reasonId = `${item.id}-reason`;

  return (
    <article className="decision-card" aria-labelledby={titleId} aria-describedby={reasonId}>
      <div className="decision-card__topline">
        <span className="project-kicker">{project.displayName}</span>
        <StatusPill
          label={item.workflowState.replaceAll("_", " ")}
          tone={item.workflowState === "CI_FAILED" ? "danger" : item.workflowState === "NEEDS_ANDRIS" ? "warning" : "info"}
        />
      </div>

      <div className="decision-card__heading">
        <div>
          <p className="decision-card__reference">
            Issue #{item.issueNumber}{item.prNumber ? ` · PR #${item.prNumber}` : ""}
          </p>
          <h3 id={titleId}>{item.prTitle ?? item.issueTitle}</h3>
        </div>
        <span className="changed-files" aria-label={`${item.changedFiles} changed files`}>
          {item.changedFiles} files
        </span>
      </div>

      <p className="decision-card__reason" id={reasonId}>
        {item.reason}
      </p>

      <div className="signal-row" aria-label="Decision evidence">
        <StatusPill label={`CI ${item.ci}`} tone={toneForCi(item.ci)} />
        <StatusPill label={`Review ${item.review.replaceAll("_", " ")}`} tone={toneForReview(item.review)} />
        <StatusPill label={item.deployImpact.replaceAll("_", " ")} tone={toneForDeploy(item.deployImpact)} />
      </div>

      <dl className="evidence-grid">
        <div>
          <dt>Expected head</dt>
          <dd><code>{shortSha(item.expectedHeadSha)}</code></dd>
        </div>
        <div>
          <dt>Observed head</dt>
          <dd><code>{shortSha(item.currentHeadSha)}</code></dd>
        </div>
        <div>
          <dt>Main</dt>
          <dd><code>{shortSha(item.mainSha)}</code></dd>
        </div>
        <div>
          <dt>Reconciled</dt>
          <dd>{reconciledLabel(item.lastReconciledAt)} UTC</dd>
        </div>
      </dl>

      {item.allowedActions.length > 0 ? (
        <div className="action-row" aria-label={`Mock actions for ${project.displayName}`}>
          {item.allowedActions.map((action) => (
            <button
              className={action === "MERGE" ? "action-button action-button--primary" : "action-button"}
              key={action}
              type="button"
              onClick={() => onMockAction(action, item)}
            >
              {actionLabels[action]}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
