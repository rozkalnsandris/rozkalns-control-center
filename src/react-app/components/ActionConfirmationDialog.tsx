import { useEffect, useRef, useState } from "react";

import { ACTION_LABELS } from "../../shared/decision-action-model";
import type { DecisionActionTarget } from "../decision-action-client";

interface ActionConfirmationDialogProps {
  target: DecisionActionTarget | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reviewBody: string) => void;
}

interface ActionConfirmationDialogContentProps {
  target: DecisionActionTarget;
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
  return `Confirm ${ACTION_LABELS[target.action]}`;
}

function actionSummary(target: DecisionActionTarget): string {
  if (target.action === "MERGE") {
    return "This sends one squash-merge request. The Worker will revalidate live GitHub state before any merge write. Merge never authorizes deployment.";
  }
  if (target.action === "NEEDS_CHANGES") {
    return "This sends one REQUEST_CHANGES decision with your review message. It never authorizes deployment.";
  }
  if (target.action === "CONTINUE") return "This enables/resumes the existing deterministic Control continuation and may reserve its next eligible task. It stops at human gates. It does not authorize merge, deployment, production data, credentials, or host changes.";
  if (target.action === "PAUSE") return "This pauses only the existing Control continuation. It does not cancel GitHub Actions, merge, deploy, or roll back production.";
  if (target.action === "RETRY_CI") return "Retry CI is unavailable until its separate capability gate is approved.";
  return "This defers the current material decision state without approving, rejecting, merging, or deploying it.";
}

function ActionConfirmationDialogContent({
  target,
  pending,
  onCancel,
  onConfirm,
}: ActionConfirmationDialogContentProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement; const dialog = dialogRef.current; dialog?.querySelector<HTMLElement>("textarea, button")?.focus(); return () => { if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  const [reviewBody, setReviewBody] = useState("");
  const needsMessage = target.action === "NEEDS_CHANGES";
  const confirmDisabled = pending || (needsMessage && reviewBody.trim().length === 0);

  return (
    <div className="decision-action-overlay" role="presentation">
      <section
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) { event.preventDefault(); onCancel(); }
          if (event.key !== "Tab") return;
          const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled)") ?? []);
          const first = items[0]; const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
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
            <dt>Expected head / main</dt>
            <dd><code>{target.item.expectedHeadSha ?? "—"}</code>{" / "}<code>{shortSha(target.item.mainSha)}</code></dd>
          </div>
          <div><dt>Deploy impact</dt><dd>{target.item.deployImpact} · This action does not deploy.</dd></div>
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
            {pending ? "Sending…" : target.action === "MERGE" ? "Confirm squash merge" : target.action === "NEEDS_CHANGES" ? "Send needs changes" : `Confirm ${ACTION_LABELS[target.action]}`}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ActionConfirmationDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: ActionConfirmationDialogProps) {
  if (!target) return null;

  return (
    <ActionConfirmationDialogContent
      key={`${target.action}:${target.item.id}`}
      target={target}
      pending={pending}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
