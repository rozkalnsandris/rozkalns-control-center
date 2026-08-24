# FAST-LANE v2.2 Composite — Rozkalns Control Center

This is the active local FAST-LANE v2.2 startup and operating contract. The older versioned filename remains only for backward compatibility. Issue #1 and all GitHub/Cloudflare/RPi5 trust boundaries remain authoritative.

## Primary operating rule

**The human approves the RISK / DECISION. Automation executes the TECHNICAL STEPS.**

STRICT describes mutation risk, not the number of human interactions. Read-only checkpoints MUST NOT create owner gates.

The Control Center target interaction is:

`one explicit human decision -> deterministic technical work continues -> next genuine human gate`

## FAST source envelope

`START`, `turpini`, or equivalent continuation may proceed from fresh canonical GitHub state through Ready for source/UI/tests/docs/deterministic orchestration work that does not expand permissions or execute a live mutation:

`fresh state -> issue/scope -> branch -> implementation -> focused tests -> commit/push -> Draft PR -> CI/review -> <=2 scope-preserving corrections -> Ready receipt -> STOP MERGE`

Batch 2-5 tightly related same-risk items inside one phase/subsystem when they form one acceptance story. Merge remains explicit and never authorizes live work.

Three failed technical attempts for one objective — initial attempt plus at most two scope-preserving corrections — require STOP before a fourth attempt.

## Human gate budget

Normal source-to-production delivery has at most two owner gates:

1. **MERGE** — exact Ready PR/head.
2. **COMPOSITE LIVE** — only when deploy/host/DB/permission/other live mutation is actually required.

Do not STOP for CI polling, GET preflight, GitHub evidence refresh, diff inspection, checkout discovery, clean/ancestor validation, build preparation, candidate GET verification or GET-only reconciliation.

Additional STOP is justified only when:

- merge authorization is required;
- one Composite Live authorization is required;
- an authorized mutation has started and an error/ambiguous result occurs;
- a new target/SHA/scope/trust-boundary/risk class appears.

## Composite Live authorization envelope

Before asking the owner, collect every obtainable read-only fact. The single authorization must bind:

- repository and exact approved Git SHA;
- exact production target/environment;
- expected production baseline version and deployment;
- exact allowed mutation categories;
- hard operation counts/limits;
- explicit exclusions.

For the GitHub-native Cloudflare Worker rollout, the bounded live mutation sequence is:

- one `wrangler versions upload` of the exact approved source;
- one deployment write preserving the approved baseline at 100% normal traffic and attaching the exact candidate at 0%;
- read-only candidate smoke verification routed explicitly to that candidate;
- one deployment write promoting that exact verified candidate to 100%.

The upload plus two deployment writes are three separately counted live mutations but may share one Composite Live owner decision because the complete sequence is pre-enumerated and all target/SHA/baseline/count limits are bound before execution.

That authorization does **not** include `reset`, `rebase`, `clean`, force operations, secrets or credential changes, permission changes, D1/Queue mutation, DNS/Tunnel/Access changes, unrelated host mutation, rollback, cleanup or any unlisted category.

If approved SHA/target/baseline changes, fail closed. Never adapt by deploying a newer `main` or a different production baseline.

## GitHub-native one-shot Control rollout

The reviewed production entrypoint is `.github/workflows/production-worker-composite-live.yml` and is manual `workflow_dispatch` only. It must run from `main`, bind to the exact approved SHA, use repository-pinned Node/Wrangler, and require the exact owner authorization string emitted from fresh preflight evidence.

The normal sequence is:

1. require workflow ref `main` and exact `GITHUB_SHA == approved_sha`;
2. re-read current GitHub `main` and exact-main successful push CI;
3. read the exact production version/deployment baseline and require single-version 100% traffic;
4. verify baseline `/api/health` through the reviewed Access service credential;
5. validate the exact source with the canonical Node runtime and full sanitized repository check;
6. revalidate exact GitHub SHA and Cloudflare baseline immediately before the first live write;
7. execute exactly one strict `wrangler versions upload`, with automatic provisioning/creation disabled;
8. capture the exact uploaded candidate version ID from Wrangler structured output;
9. create exactly one deployment keeping the approved baseline at 100% and candidate at 0% normal traffic;
10. re-read that deployment and require the exact baseline/candidate pair and percentages;
11. issue bounded GET-only smoke requests with `Cloudflare-Workers-Version-Overrides` targeting the candidate;
12. require `/api/health.workerVersion` to equal the exact uploaded candidate ID — HTTP 200 alone is not candidate proof;
13. re-read GitHub main and current deployment as a pre-promotion drift guard;
14. create exactly one deployment promoting the exact verified candidate to 100%;
15. GET-only reconciliation must prove a single-version 100% deployment and `/api/health.workerVersion` equal to the exact promoted candidate;
16. emit one final receipt with mutation counts and before/candidate/after identities.

Cloudflare version overrides only target versions in the current deployment. Therefore the 0%-traffic attachment is required for this Worker because `workers_dev=false` and `preview_urls=false`; it lets the exact candidate be smoke-tested without normal production traffic being routed to it.

The version metadata binding `CF_VERSION_METADATA` is part of the runtime contract. `/api/health` returns its exact Worker version ID with `Cache-Control: no-store`, making a failed override unable to masquerade as candidate success by falling back to the baseline version.

If any error, ambiguity, identity mismatch or drift occurs after the first mutation starts, preserve evidence and STOP. A candidate left attached at 0% after a failed smoke test is evidence, not permission to perform automatic cleanup.

## GitHub production credential boundary

The existing GitHub environment `production-readonly-reconcile` deliberately uses a Cloudflare `Workers Scripts Read` token and must remain read-only.

The production deployment workflow instead names a distinct environment `production-worker-deploy`. Before the first live run, that environment must be separately owner-approved and provisioned with only the credentials required for this bounded path:

- `CLOUDFLARE_API_TOKEN` — exact-account token with the minimum Worker write permission required for version upload/deployment;
- `CONTROL_ACCESS_CLIENT_ID`;
- `CONTROL_ACCESS_CLIENT_SECRET`.

Creating that environment, adding/rotating those secrets, changing token permissions, or changing Access policy is a separate trust-boundary mutation. Merging the workflow source does not authorize or perform that setup.

## Local STRICT boundaries

Composite Live authorization is required for production DB writes/migrations, GitHub App permission expansion, source-write capability activation, Cloudflare production mutation, RPi5/root/systemd/Docker/network changes, secrets/credentials, destructive cleanup and production rollout. Existing issue #1 / RPi5 contracts may impose stricter boundaries.

## Failure / rollback

Authorization is consumed at the first authorized mutation. After that, any error, ambiguity, unexpected drift or new scope requires evidence preservation and STOP.

Default behavior is no automatic retry, rollback, cleanup, reset, rebase or alternate mutation path. Rollback is itself a production mutation and requires explicit pre-authorization unless a narrower governing contract already proves and authorizes it.

## State model

Use these coarse states instead of inventing micro-states:

`SOURCE_FAST -> READY_MERGE -> WAITING_MERGE_AUTH -> POST_MERGE_READONLY -> WAITING_COMPOSITE_LIVE_AUTH -> LIVE_EXECUTING -> DONE`

Failure path after first mutation:

`LIVE_EXECUTING -> STOP_ERROR`

## Evidence and operator UX

Source work produces one Ready receipt. Live execution produces one final receipt containing approved/observed SHA, target, before/after production version/baseline, actual mutation counts, candidate verification, reconciliation, whether first mutation started/authorization was consumed, whether production changed and the exact next decision.

Do not make the owner shuttle intermediate output while automation can continue safely.

Any owner decision must be placed visibly at the **very end** of the response under one `ACTION REQUIRED` heading. First state what is done and what is not done. Then provide exactly the needed decision/command. When the owner must type or run something, put the exact copyable value in a fenced `bash` block.

## Merge invariant

Merge is always a separate owner decision and never authorizes deploy, DB, host, credential, permission or another live mutation.
