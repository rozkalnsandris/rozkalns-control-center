import { useEffect, useRef } from "react";

import { OWNER_ACTION_LABELS } from "../../shared/owner-action-model";
import type { DecisionActionTarget } from "../decision-action-client";

interface ActionConfirmationDialogProps { target: DecisionActionTarget | null; pending: boolean; onCancel: () => void; onConfirm: (reviewBody: string) => void; }
interface ActionConfirmationDialogContentProps { target: DecisionActionTarget; pending: boolean; onCancel: () => void; onConfirm: (reviewBody: string) => void; }
function shortSha(value: string | null): string { return value ? value.slice(0, 8) : "—"; }
function actionTitle(target: DecisionActionTarget): string { if (target.action === "MERGE") return "Confirm squash merge"; return `Confirm ${OWNER_ACTION_LABELS[target.action]}`; }
function actionSummary(target: DecisionActionTarget): string {
  if (target.action === "MERGE") return "This sends one squash-merge request. The Worker will revalidate live GitHub state before any merge write. Merge never authorizes deployment.";
  if (target.action === "LIVE") return "This is a separate production decision. The Worker will revalidate the exact current main SHA, then dispatch only the reviewed Live workflow configured for this project.";
  return "This sends one wake signal to the reviewed continuation workflow. The receiver must re-read canonical GitHub state. Continue grants neither merge nor production authority.";
}
function ActionConfirmationDialogContent({ target, pending, onCancel, onConfirm }: ActionConfirmationDialogContentProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement; const dialog = dialogRef.current; dialog?.querySelector<HTMLElement>("button")?.focus(); return () => { if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  return <div className="decision-action-overlay" role="presentation"><section ref={dialogRef} onKeyDown={(event) => { if (event.key === "Escape" && !pending) { event.preventDefault(); onCancel(); } if (event.key !== "Tab") return; const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []); const first = items[0]; const last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }} className="decision-action-dialog" role="dialog" aria-modal="true" aria-labelledby="decision-action-title" aria-describedby="decision-action-description">
    <p className="eyebrow">Explicit human action</p><h2 id="decision-action-title">{actionTitle(target)}</h2><p id="decision-action-description">{actionSummary(target)}</p>
    <dl className="decision-action-evidence"><div><dt>Project</dt><dd>{target.project.displayName}</dd></div><div><dt>Repository</dt><dd><code>{target.project.repository}</code></dd></div><div><dt>Issue / PR</dt><dd>{target.item.issueNumber !== null ? `#${target.item.issueNumber}` : "—"}{" / "}{target.item.prNumber !== null ? `#${target.item.prNumber}` : "—"}</dd></div><div><dt>Expected head / main</dt><dd><code>{target.item.expectedHeadSha ?? "—"}</code>{" / "}<code>{shortSha(target.item.mainSha)}</code></dd></div><div><dt>Deploy impact</dt><dd>{target.item.deployImpact}{target.action === "LIVE" ? " · Live is separately authorized by this confirmation." : " · This action does not authorize deployment."}</dd></div></dl>
    <div className="decision-action-dialog__actions"><button type="button" className="action-button action-button--tertiary" onClick={onCancel} disabled={pending}>Cancel</button><button type="button" className={target.action === "CONTINUE" ? "action-button action-button--secondary" : "action-button action-button--primary"} onClick={() => onConfirm("")} disabled={pending} data-confirm-action={target.action} aria-busy={pending}>{pending ? "Sending…" : target.action === "MERGE" ? "Confirm squash merge" : `Confirm ${OWNER_ACTION_LABELS[target.action]}`}</button></div>
  </section></div>;
}
export function ActionConfirmationDialog({ target, pending, onCancel, onConfirm }: ActionConfirmationDialogProps) { if (!target) return null; return <ActionConfirmationDialogContent key={`${target.action}:${target.item.id}`} target={target} pending={pending} onCancel={onCancel} onConfirm={onConfirm} />; }
