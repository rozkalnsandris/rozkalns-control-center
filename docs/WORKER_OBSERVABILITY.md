# Worker observability contract

This source contract makes Worker logs and traces explicit and cost-bounded. It does not deploy or mutate the production Worker.

## Structured application events

`src/worker/structured-logging.ts` emits one fixed-shape event after each Worker request or Queue invocation. Records contain only a stable route code, bounded method/status/outcome/error code, duration, sanitized Worker version, a strictly validated Cloudflare Ray identifier when present, and Queue message count. Unknown paths and Queue names collapse to fixed codes.

The boundary never reads or records query-string values, request or response bodies, cookies, Access assertions, authorization headers, GitHub credentials, webhook signatures or payloads, review text, action bodies, private keys, or protected configuration. Exceptions are represented by stable error codes instead of their messages or stacks. Logging failure cannot change request or Queue behavior.

## Sampling and query strings

`wrangler.jsonc` explicitly persists custom logs with 10% head sampling and traces with 5% head sampling. Automatic invocation logs are disabled because their request message includes the URL. The pinned Wrangler 4.120 schema does not accept Cloudflare's newer `redact_query_string` API field, so that unsupported property is not guessed into source configuration. The application logger emits a fixed route code and never emits the raw URL. Re-evaluate native redaction when a future pinned Wrangler schema exposes it.

Cloudflare documents a default sampling rate of 100% when a rate is omitted. Repository tests reject 100% trace sampling and require the explicit 5% ceiling.

## Cost boundary

Cloudflare currently describes Workers tracing as beta and free through 2026-09-30. Beginning **2026-10-01**, each trace span is billed as a Workers observability event. The Workers Free plan currently includes 200,000 log or trace events per day with three-day retention. The 5% trace rate and 10% log rate deliberately keep the small Control workload below those volumes; production usage must still be reviewed before any separately authorized deployment.

Current official references:

- https://developers.cloudflare.com/workers/observability/traces/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/workers/wrangler/configuration/#observability
