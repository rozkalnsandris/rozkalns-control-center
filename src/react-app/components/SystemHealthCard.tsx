import { useEffect, useState } from "react";

import {
  classifyWebhookDeliveryObservation,
  isWebhookDeliveryObservabilitySnapshot,
  type WebhookDeliveryDiagnostic,
  type WebhookDeliveryObservabilitySnapshot,
  type WebhookDeliveryObservabilityStatus,
} from "../../shared/webhook-delivery-observability";
import { isAbortedControlRead, readControlJson } from "../read-only-fetch";
import { StatusPill } from "./StatusPill";

type ObservabilityReadState = "LOADING" | "READY" | "STALE" | "FUTURE" | "INVALID" | "ERROR";

interface SystemHealthCardProps {
  readonly refreshSequence: number;
}

interface ObservabilityReadResult {
  readonly sequence: number;
  readonly state: ObservabilityReadState;
  readonly snapshot: WebhookDeliveryObservabilitySnapshot | null;
}

function timestampLabel(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return "Invalid timestamp";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(parsed);
}

function statusTone(status: WebhookDeliveryObservabilityStatus) {
  if (status === "HEALTHY") return "good" as const;
  if (status === "ACTIVE") return "info" as const;
  return "warning" as const;
}

function readDetail(
  state: ObservabilityReadState,
  snapshot: WebhookDeliveryObservabilitySnapshot | null,
): string {
  if (state === "LOADING") return snapshot ? "Refreshing delivery health" : "Checking delivery health";
  if (state === "ERROR") return snapshot
    ? "Delivery health unavailable · showing last-known bounded evidence"
    : "Delivery health unavailable · status is not assumed healthy";
  if (state === "STALE") return "Delivery observation is stale · showing last-known bounded evidence";
  if (state === "FUTURE") return "Delivery observation exceeds the clock-skew allowance";
  if (state === "INVALID") return "Delivery observation timestamp is invalid";
  if (snapshot?.status === "ATTENTION") return "Stale or dead-lettered delivery evidence needs attention";
  if (snapshot?.status === "ACTIVE") return "Reconciliation delivery work is active";
  return "No stale or dead-lettered delivery evidence";
}

function diagnosticLabel(diagnostic: WebhookDeliveryDiagnostic): string {
  return `${diagnostic.repository} · ${diagnostic.eventName} · ${timestampLabel(diagnostic.updatedAt)} UTC`;
}

export function SystemHealthCard({ refreshSequence }: SystemHealthCardProps) {
  const [result, setResult] = useState<ObservabilityReadResult>({
    sequence: -1,
    state: "LOADING",
    snapshot: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void readControlJson("/api/github/webhook-deliveries", {
      signal: controller.signal,
      validate: isWebhookDeliveryObservabilitySnapshot,
    }).then((payload) => {
      if (!active) return;
      const freshness = classifyWebhookDeliveryObservation(payload.observedAt);
      setResult({
        sequence: refreshSequence,
        state: freshness === "FRESH" ? "READY" : freshness,
        snapshot: payload,
      });
    }).catch((error: unknown) => {
      if (!active || isAbortedControlRead(error)) return;
      setResult((current) => ({
        sequence: refreshSequence,
        state: "ERROR",
        snapshot: current.snapshot,
      }));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [refreshSequence]);

  const snapshot = result.snapshot;
  const readState: ObservabilityReadState =
    result.sequence === refreshSequence ? result.state : "LOADING";
  const displayedStatus: WebhookDeliveryObservabilityStatus =
    readState === "READY" && snapshot ? snapshot.status : "ATTENTION";
  const observed = snapshot ? `${timestampLabel(snapshot.observedAt)} UTC` : "Unknown";

  return (
    <section className="dashboard-section system-health" aria-labelledby="system-health-title">
      <div className="section-heading">
        <div><p className="eyebrow">Read-only operational evidence</p><h2 id="system-health-title">Reconciliation health</h2></div>
        <StatusPill label={displayedStatus} tone={statusTone(displayedStatus)} />
      </div>
      <p className="system-health__detail">{readDetail(readState, snapshot)}</p>
      <dl className="system-health__metrics">
        <div><dt>Non-terminal</dt><dd>{snapshot?.nonTerminalCount ?? "—"}</dd></div>
        <div><dt>Stale</dt><dd>{snapshot?.staleEvidenceCount ?? "—"}</dd></div>
        <div><dt>Dead-lettered</dt><dd>{snapshot?.deadLetteredCount ?? "—"}</dd></div>
        <div><dt>Observed</dt><dd>{observed}</dd></div>
      </dl>
      {snapshot && snapshot.diagnostics.length > 0 ? (
        <details className="system-health__diagnostics">
          <summary>Sanitized diagnostics · {snapshot.diagnostics.length}{snapshot.diagnosticsTruncated ? "+" : ""}</summary>
          <ul>
            {snapshot.diagnostics.map((diagnostic) => (
              <li key={diagnostic.deliveryId}>
                <strong>{diagnostic.disposition} · {diagnostic.state}</strong>
                <span>{diagnosticLabel(diagnostic)}</span>
                {diagnostic.lastErrorCode ? <code>{diagnostic.lastErrorCode}</code> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="system-health__safety">Evidence only · no retry, requeue, delete or DLQ controls</p>
    </section>
  );
}
