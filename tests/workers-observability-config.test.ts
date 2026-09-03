import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Workers observability is explicit, query-safe and cost-bounded", async () => {
  const [configSource, schemaSource, documentation] = await Promise.all([
    readFile("wrangler.jsonc", "utf8"),
    readFile("node_modules/wrangler/config-schema.json", "utf8"),
    readFile("docs/WORKER_OBSERVABILITY.md", "utf8"),
  ]);
  const config = JSON.parse(configSource) as {
    observability?: {
      enabled?: boolean;
      logs?: { enabled?: boolean; head_sampling_rate?: number; invocation_logs?: boolean; persist?: boolean };
      traces?: { enabled?: boolean; head_sampling_rate?: number; persist?: boolean };
    };
  };
  const schema = JSON.parse(schemaSource) as {
    definitions?: { Observability?: { properties?: Record<string, unknown> } };
  };

  assert.deepEqual(config.observability, {
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 0.1, invocation_logs: false, persist: true },
    traces: { enabled: true, head_sampling_rate: 0.05, persist: true },
  });
  assert.ok(config.observability.traces.head_sampling_rate > 0);
  assert.ok(config.observability.traces.head_sampling_rate <= 0.05);
  assert.notEqual(config.observability.traces.head_sampling_rate, 1);
  assert.ok(config.observability.logs.head_sampling_rate <= 0.1);
  assert.equal("redact_query_string" in (schema.definitions?.Observability?.properties ?? {}), false);
  assert.match(documentation, /pinned Wrangler 4\.120 schema does not accept/);
  assert.match(documentation, /2026-10-01/);
  assert.match(documentation, /200,000.*per day/);
});
