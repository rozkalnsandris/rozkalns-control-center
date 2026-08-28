import { useEffect, useState } from "react";

import type { DecisionActionTarget } from "../decision-action-client";

interface ActionConfirmationDialogProps {
  target: DecisionActionTarget | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reviewBody: string) => void;
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

function actionTitle(target: DecisionActionTarget): string {
  if (target.action === "MERGE") return "Confirm squash merge";
  if (target.action === "NEEDS_CHANGES") return "Confirm needs changes";
  return "Confirm Later";
}

function actionSummary(target: DecisionActionTarget): string {
  if (target.action === "MERGE") {
    return "This sends one squash-merge request. The Worker will revalidate live GitHub state before any merge write. Merge never authorizes deployment.";
  }
  if (target.action === "NEEDS_CHANGES") {
    return "This sends one REQUEST_CHANGES decision with your review message. It never authorizes deployment.";
  }
  return "This defers the current material decision state without approving, rejecting, merging, or deploying it.";
}

export function ActionConfirmationDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: ActionConfirmationDialogProps) {
  const [reviewBody, setReviewBody] = useState("");

  useEffect(() => {
    setReviewBody("");
  }, [target?.action, target?.item.id]);

  if (!target) return null;

  const needsMessage = target.action === "NEEDS_CHANGES";
  const confirmDisabled = pending || (needsMessage && reviewBody.trim().length === 0);

  return (
    <div className="decision-action-overlay" role="presentation">
      <section
        className="decision-action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-action-title"
        aria-describedby="decision-action-description"
      >
        <p className="eyebrow">Explicit human action</p>
        <h2 id="decision-action-title">{actionTitle(target)}</h2>
        <p id="decision-action-description">{actionSummary(target)}</p>

        <dl className="decision-action-evidence">
          <div><dt>Project</dt><dd>{target.project.displayName}</dd></div>
          <div><dt>Repository</dt><dd><code>{target.project.repository}</code></dd></div>
          <div>
            <dt>Issue / PR</dt>
            <dd>{target.item.issueNumber !== null ? `#${target.item.issueNumber}` : "—"}{" / "}{target.item.prNumber !== null ? `#${target.item.prNumber}` : "—"}</dd>
          </div>
          <div>
            <dt>Head / main</dt>
            <dd><code>{shortSha(target.item.currentHeadSha)}</code>{" / "}<code>{shortSha(target.item.mainSha)}</code></dd>
          </div>
        </dl>

        {needsMessage ? (
          <label className="decision-action-review">
            <span>Review message</span>
            <textarea
              value={reviewBody}
              onChange={(event) => setReviewBody(event.target.value)}
              maxLength={4096}
              disabled={pending}
              rows={5}
              autoFocus
              aria-describedby="decision-action-review-help"
            />
            <small id="decision-action-review-help">Required · maximum 4096 UTF-8 bytes. The server validates the same bound.</small>
          </label>
        ) : null}

        <div className="decision-action-dialog__actions">
          <button type="button" className="action-button action-button--tertiary" onClick={onCancel} disabled={pending}>Cancel</button>
          <button
            type="button"
            className={target.action === "MERGE" ? "action-button action-button--primary" : "action-button action-button--secondary"}
            onClick={() => onConfirm(reviewBody)}
            disabled={confirmDisabled}
            data-confirm-action={target.action}
            aria-busy={pending}
          >
            {pending ? "Sending…" : target.action === "MERGE" ? "Confirm squash merge" : target.action === "NEEDS_CHANGES" ? "Send needs changes" : "Confirm Later"}
          </button>
        </div>
      </section>
    </div>
  );
}
