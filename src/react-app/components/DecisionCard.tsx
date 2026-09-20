import { useEffect, useState } from "react";

import type { DecisionReadModel, ProjectReadModel } from "../../shared/control-model";
import { decisionDeepLinkHash, decisionTargetId } from "../../shared/decision-deep-link";
import { OWNER_ACTIONS, OWNER_ACTION_LABELS, ownerActionPresentationState, type OwnerAction } from "../../shared/owner-action-model";
import type { MutatingDecisionAction } from "../decision-action-client";
import { applyAuthoritativeGitHubWriteEligibility, readAuthoritativeGitHubWriteEligibility, type AuthoritativeGitHubWriteEligibility } from "../needs-changes-eligibility-client";
import { normalizeDecisionActions } from "../../shared/decision-action-model";
import { StatusPill } from "./StatusPill";

interface DecisionCardProps {
  item: DecisionReadModel;
  project: ProjectReadModel;
  onAction: (action: MutatingDecisionAction, item: DecisionReadModel, project: ProjectReadModel) => void;
  mutationsLocked: boolean;
  live: boolean;
  nowMs: number;
  blockedReason?: string;
}
interface EligibleHydration extends AuthoritativeGitHubWriteEligibility { readonly identity: string; readonly receivedAt: number; }
function toneForCi(ci: DecisionReadModel["ci"]) { if (ci === "PASS") return "good" as const; if (ci === "FAIL") return "danger" as const; return "info" as const; }
function toneForReview(review: DecisionReadModel["review"]) { if (review === "PASS") return "good" as const; if (review === "CHANGES_REQUESTED") return "danger" as const; if (review === "PENDING") return "warning" as const; return "neutral" as const; }
function humanize(value: string) { return value.replace(/_/g, " "); }
function shortSha(sha: string | null) { return sha ? sha.slice(0, 8) : "—"; }
function reconciledLabel(timestamp: string) { const parsed = new Date(timestamp); return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(parsed) : "Invalid timestamp"; }
function headEvidence(item: DecisionReadModel) { if (!item.expectedHeadSha && !item.currentHeadSha) return { label: "Head pending", tone: "warning" as const }; if (item.expectedHeadSha && item.expectedHeadSha === item.currentHeadSha) return { label: "Head match", tone: "good" as const }; return { label: "Head mismatch", tone: "danger" as const }; }
function actionClass(action: OwnerAction, enabled = true) { if ((action === "MERGE" || action === "LIVE") && enabled) return "action-button action-button--primary"; return "action-button action-button--secondary"; }
function referenceLabel(item: DecisionReadModel) { const parts: string[] = []; if (item.issueNumber !== null) parts.push(`Issue #${item.issueNumber}`); if (item.prNumber !== null) parts.push(`PR #${item.prNumber}`); return parts.join(" · "); }
function hydrationIdentity(item: DecisionReadModel, project: ProjectReadModel): string { return JSON.stringify([project.id, project.repository, project.enabled, item.projectId, item.issueNumber, item.prNumber, item.expectedHeadSha, item.currentHeadSha, item.mainSha, item.lastReconciledAt, item.allowedActions, item.actionStates]); }

export function DecisionCard({ item, project, onAction, mutationsLocked, live, nowMs, blockedReason }: DecisionCardProps) {
  const targetId = decisionTargetId(item.id); const titleId = `${targetId}-title`; const reasonId = `${targetId}-reason`;
  const evidenceLabel = `Evidence · ${reconciledLabel(item.lastReconciledAt)} UTC`; const reference = referenceLabel(item); const title = item.prTitle ?? item.issueTitle ?? "Untitled change"; const head = headEvidence(item); const showReason = item.workflowState === "NEEDS_ANDRIS";
  const currentHydrationIdentity = hydrationIdentity(item, project);
  const [eligibleHydration, setEligibleHydration] = useState<EligibleHydration | null>(null);
  const currentEligibility = live && eligibleHydration?.identity === currentHydrationIdentity && nowMs - eligibleHydration.receivedAt <= 60_000 ? eligibleHydration : { merge: false, needsChanges: false };
  const eligibleItem = applyAuthoritativeGitHubWriteEligibility(item, currentEligibility);
  const renderedItem = normalizeDecisionActions(eligibleItem, project, { live, nowMs, blockedReason, verifiedGitHub: currentEligibility });

  useEffect(() => { if (window.location.hash !== decisionDeepLinkHash(item.id)) return; const frame = window.requestAnimationFrame(() => { const target = document.getElementById(targetId); if (!(target instanceof HTMLElement)) return; target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true }); }); return () => window.cancelAnimationFrame(frame); }, [item.id, targetId]);
  useEffect(() => {
    const controller = new AbortController(); let active = true; const requestedIdentity = currentHydrationIdentity;
    if (!live) return () => controller.abort();
    void readAuthoritativeGitHubWriteEligibility(item, project, { signal: controller.signal }).then((eligibility) => { if (!active || controller.signal.aborted) return; if (!eligibility.merge && !eligibility.needsChanges) { setEligibleHydration(null); return; } setEligibleHydration({ identity: requestedIdentity, receivedAt: Date.now(), ...eligibility }); });
    return () => { active = false; controller.abort(); };
  }, [currentHydrationIdentity, item, project, live]);

  return <article className="decision-card" id={targetId} tabIndex={-1} aria-labelledby={titleId} aria-describedby={showReason ? reasonId : undefined}>
    <div className="decision-card__topline"><span className="project-kicker">{project.displayName}</span><StatusPill label={humanize(item.workflowState)} tone={item.workflowState === "CI_FAILED" ? "danger" : item.workflowState === "NEEDS_ANDRIS" ? "warning" : "info"} /></div>
    <div className="decision-card__heading"><div>{reference ? <p className="decision-card__reference">{reference}</p> : null}<h3 id={titleId}>{title}</h3></div><span className="changed-files" aria-label={`${item.changedFiles} changed files`}>{item.changedFiles} files</span></div>
    {showReason ? <p className="decision-card__reason" id={reasonId}>{item.reason}</p> : null}
    <div className="signal-row" aria-label="Decision evidence"><StatusPill label={`CI ${item.ci}`} tone={toneForCi(item.ci)} /><StatusPill label={`Review ${humanize(item.review)}`} tone={toneForReview(item.review)} /><StatusPill label={head.label} tone={head.tone} /></div>
    <details className="evidence-details"><summary>{evidenceLabel}</summary>{!showReason ? <p className="evidence-reason"><span>Reason</span>{item.reason}</p> : null}<dl className="evidence-grid"><div><dt>Expected head</dt><dd><code>{shortSha(item.expectedHeadSha)}</code></dd></div><div><dt>Observed head</dt><dd><code>{shortSha(item.currentHeadSha)}</code></dd></div><div><dt>Main</dt><dd><code>{shortSha(item.mainSha)}</code></dd></div><div><dt>Deploy impact</dt><dd>{humanize(item.deployImpact)}</dd></div><div><dt>Reconciled</dt><dd>{reconciledLabel(item.lastReconciledAt)} UTC</dd></div></dl></details>
    <div className="action-panel" aria-label={`Owner actions for ${project.displayName}`}>
      {OWNER_ACTIONS.map((action) => {
        const state = ownerActionPresentationState(action, item, project, { live, mutationsLocked, mergeEnabled: renderedItem.actionStates?.MERGE.state === "enabled", ...(blockedReason ? { blockedReason } : {}) });
        const enabled = state.state === "enabled"; const descriptionId = `${targetId}-${action}-reason`;
        return <div className="action-panel__entry" key={action}><button className={actionClass(action, enabled)} type="button" aria-disabled={!enabled} aria-describedby={state.reason ? descriptionId : undefined} data-decision-action={action} onClick={() => {
          if (!enabled) return;
          const expiresAt = action === "MERGE" ? Math.min(Date.parse(item.lastReconciledAt) + 300_000, (eligibleHydration?.receivedAt ?? 0) + 60_000) : Math.min(Date.parse(item.lastReconciledAt) + 300_000, Date.now() + 60_000);
          if (action === "MERGE") onAction(action, { ...renderedItem, actionEligibilityExpiresAt: expiresAt }, project);
          else {
            const actionItem = { ...item, actionEligibilityExpiresAt: expiresAt, actionStates: { ...renderedItem.actionStates, [action]: { state: "enabled", reason: null } } } as DecisionReadModel;
            onAction(action, actionItem, project);
          }
        }}>{OWNER_ACTION_LABELS[action]}</button>{state.reason ? <small id={descriptionId}>{state.reason}</small> : null}</div>;
      })}
    </div>
  </article>;
}
