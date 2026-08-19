import type { DashboardSummary } from "../shared/control-model.js";

export type OperatorAttentionTone = "attention" | "danger" | "clear";

export interface OperatorAttention {
  readonly tone: OperatorAttentionTone;
  readonly headline: string;
  readonly detail: string;
  readonly target: "#needs-andris" | "#ci-failed" | null;
  readonly actionLabel: string | null;
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function operatorAttentionForSummary(summary: DashboardSummary): OperatorAttention {
  if (summary.needsAndris > 0) {
    return {
      tone: "attention",
      headline: `${countLabel(summary.needsAndris, "item needs", "items need")} your decision`,
      detail: "This snapshot has an explicit owner-action gate. Review it before the lower-priority status sections.",
      target: "#needs-andris",
      actionLabel: "Review owner actions",
    };
  }

  if (summary.ciFailed > 0) {
    return {
      tone: "danger",
      headline: "No owner decision requested",
      detail: `${countLabel(summary.ciFailed, "CI failure is", "CI failures are")} blocking progress in this snapshot.`,
      target: "#ci-failed",
      actionLabel: "Review CI failures",
    };
  }

  return {
    tone: "clear",
    headline: "No owner action requested",
    detail: "This snapshot reports no owner-action gate and no CI failure.",
    target: null,
    actionLabel: null,
  };
}
