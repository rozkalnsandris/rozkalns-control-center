import { useEffect, useState } from "react";

import type { HealthPayload } from "../shared/health";

export default function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [unavailable, setUnavailable] = useState(false);

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

  return (
    <main className="shell">
      <section className="card" aria-labelledby="page-title">
        <p className="eyebrow">Phase 0 bootstrap</p>
        <h1 id="page-title">Rozkalns Control</h1>
        <p className="summary">
          Runtime skeleton only. The mobile approval experience starts in Phase 1.
        </p>
        <dl className="status-grid">
          <div>
            <dt>Worker API</dt>
            <dd>{health?.status === "ok" ? "Ready" : unavailable ? "Unavailable" : "Checking…"}</dd>
          </div>
          <div>
            <dt>Phase</dt>
            <dd>{health?.phase ?? "phase-0"}</dd>
          </div>
          <div>
            <dt>Production</dt>
            <dd>Not deployed</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
