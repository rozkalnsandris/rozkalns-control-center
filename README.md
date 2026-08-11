# Rozkalns Control

Mobile-first control and approval plane for Andris' engineering projects.

> **Status:** Phase 2 live read-only GitHub integration — source-only authoritative GitHub read-provider adapter is in progress through issue #42 / PR #43. No live GitHub App, permission mutation, credential minting, Cloudflare production binding, RPi5 mutation or deployment is authorized by the current work.

The canonical product contract is GitHub issue **#1 — `[MASTER / READ FIRST] Rozkalns Control — product contract, architecture and delivery roadmap`**. Read it before starting implementation work.

## What this product is for

The normal daily flow should become:

`work progresses → Needs Andris → phone notification → review evidence → Merge / Needs changes / Later → close phone → safe automation continues`

The first useful release is intentionally focused on approvals and visibility rather than AI-provider integration.

### MVP

- Android-first `Needs Andris` queue;
- project, issue, PR, CI and review visibility;
- safe deterministic `Merge`, `Needs changes` and `Later` actions;
- stale-head/SHA and CI revalidation before mutations;
- quiet notifications with deep links to the exact decision;
- existing GitHub/RPi5 automation remains authoritative after merge;
- no OpenAI/Claude API requirement.

### Not MVP

- autonomous AI coding workers;
- Cloudflare Sandbox SDK;
- AI Gateway/provider routing;
- direct RPi5 SSH/sudo or production mutation;
- production DB writes from the control plane.

## Initial managed projects

- `rozkalnsandris/hermes-tech`
- `rozkalnsandris/hermes-deals`
- `rozkalnsandris/rozkalns-cv`
- `rozkalnsandris/RPi5_main`
- `rozkalnsandris/ops-workflows`
- `rozkalnsandris/rozkalnsandris`

`rozkalnsandris/hermes-email-skill` is explicitly excluded from the initial scope.

## Trust boundaries

- **GitHub** — source of truth for repository, SHA, issues, PRs, reviews and CI.
- **Rozkalns Control** — approval/orchestration projection, notification state and audit evidence.
- **ChatGPT** — current reasoning/operator layer through the connected GitHub app where supported; not a canonical state store.
- **RPi5** — production trust boundary, exact-SHA deploy rules, health and rollback authority.

**Merge authorization is not deploy authorization.**

## Phase 1 UI baseline

Phase 1 proved the phone UX with deterministic fixture data before adding integration permissions.

The fixture dashboard contains:

- `Needs Andris` first;
- Working / Waiting;
- CI Failed;
- Merge Ready;
- Projects overview;
- decision cards with PR/CI/review/SHA/deploy evidence;
- mock-only `Merge`, `Needs changes`, `Later` and `Open PR` controls;
- explicit `Fixture mode` labeling so demo data cannot be confused with live state.

Mock actions change only local React notice state. They do not call GitHub, Cloudflare or RPi5.

Accessibility/mobile baseline:

- Samsung Galaxy A55-class compact portrait layout is first-class without device sniffing or physical-pixel hardcoding;
- semantic landmarks/headings;
- visible keyboard focus;
- skip-to-content navigation;
- status meaning in text, not color alone;
- primary actions at least 52 CSS px high;
- safe-area/dynamic-viewport handling;
- mobile-first single-column layout with wider-screen enhancement.

See [`docs/PHASE1_UI_NOTES.md`](docs/PHASE1_UI_NOTES.md).

## Current Phase 2 source preflight

Phase 2 replaces fixture state with trustworthy live GitHub projections, but the current implementation remains deliberately source-only until the separately governed live-rollout gate opens.

Current source contracts now cover:

- configuration-driven managed-repository allow-list;
- provider-neutral GitHub read boundary with no mutation methods;
- exact-head PR, merge-state, Check Run, commit-status and workflow evidence binding;
- fail-closed REST/GraphQL payload mappers for consumed fields;
- conservative CI aggregation across required Checks and commit statuses;
- GitHub required-Check semantics for `success`, `neutral` and `skipped`;
- Check Run producer GitHub App identity for App-bound required checks;
- latest-provable Check Run selection per case-insensitive context + producer App, with ambiguous ordering kept conservative;
- latest effective commit-status selection per case-insensitive context;
- latest-provable workflow-run selection per workflow identity/run number/attempt, with missing identity never silently collapsed;
- latest-effective review aggregation with explicit policy requirements;
- exact-head `MERGEABLE/CLEAN` readiness gate;
- branch-policy provenance across active rulesets and classic branch protection;
- classic branch-protection `app_id`, approval and complex-review semantics;
- fail-closed webhook HMAC verification where repository identity is derived from the same authenticated payload;
- delivery-ID deduplication abstraction and reconciliation triggers requiring a fresh authoritative GitHub read;
- versioned minimal reconciliation Queue-message contract with unknown-field rejection;
- explicit durable delivery lifecycle and terminal `DEAD_LETTERED` state;
- source-controlled initial D1 migration with `delivery_id` primary-key idempotency and no secret/payload columns;
- type-aware `@typescript-eslint/no-floating-promises` enforcement for production `src/` TypeScript before live async handlers are introduced;
- source-only GitHub App installation-read scope, short-lived credential-lease evidence and GET-only REST request contracts with no raw credential material in domain/business interfaces;
- concrete bounded GitHub REST GET transport under the dedicated integration path, with fixed origin/API media/version metadata, manual redirect policy, repository-bound Link pagination, request-budget/cycle protection and sanitized rate-limit evidence;
- typed fail-closed REST outcomes for auth/status/rate-limit/pagination/malformed-response failures, without automatic retry loops;
- source-only GitHub App JWT / installation-token boundary with deterministic `RS256` signing input, explicit repository/read-permission narrowing, exact returned-scope verification and raw JWT/token material confined to the dedicated integration layer;
- separate authorized REST GET and fixed GraphQL merge-state sessions that reuse the same private credential-acquisition boundary without exposing raw tokens or widening the REST interface;
- bounded GraphQL merge-state transport fixed to `https://api.github.com/graphql`, one named query, exact repository/PR variables and only `number`, `headRefOid`, `mergeable`, `mergeStateStatus`, `isDraft` fields;
- strict GraphQL partial-data/error handling plus sanitized HTTP-200 primary/secondary rate-limit evidence with no automatic retry loop;
- machine-readable staged GitHub App rollout plan derived from managed-project policy, beginning with Metadata-only repository/rules canaries and expanding read permissions one stage at a time;
- conditional `Commit statuses: read` activation only when repository evidence proves legacy status reads are required, while `Administration: read` remains outside the rollout source contract;
- explicit authoritative snapshot commit-status coverage: `OBSERVED` means the source was actually read; `NOT_REQUESTED` skips the endpoint and remains fail-closed for required status-check contexts;
- concrete source-only authoritative GitHub provider adapter that composes only the bounded REST and fixed GraphQL transports, binds fixed endpoint→permission pairs, excludes PR entries returned by the Issues API, requests Check rerun evidence with `filter=all`, and reuses one explicit observation time per provider/snapshot;
- documented future endpoint → minimum GitHub App permission requirements.

Phase 2 application projection still exposes only `OPEN_PR`; it does **not** expose a live Merge mutation.

There are still **no live GitHub API calls from Worker routes, real credentials, dedicated Control GitHub App installation, Cloudflare secret binding, D1/Queue/Workflow bindings or production deploy path** in the current repository. REST/GraphQL credential sessions, transports and the concrete provider remain disconnected from `src/worker/index.ts` and use deterministic source/test dependencies only.

`RPi5_main#163` is complete. The current RPi5 Phase 3 first incomplete gate is issue #140: wait for a genuinely newer exact-current-main CV delta that independently classifies `AUTO_DEPLOY_SAFE` with `CONTROL_PLANE_CHANGED=false`, then separately review/authorize exactly one one-shot controller canary while the recurring timer remains disabled. This does not authorize Control live rollout; a real GitHub App/permission/credential step still requires a separate owner gate and fresh sequencing reconciliation.

See:

- [`docs/PHASE2_GITHUB_READ_CONTRACT.md`](docs/PHASE2_GITHUB_READ_CONTRACT.md)
- [`docs/PHASE2_GITHUB_PROJECTION_CONTRACT.md`](docs/PHASE2_GITHUB_PROJECTION_CONTRACT.md)
- [`docs/PHASE2_GITHUB_MERGE_STATE_CONTRACT.md`](docs/PHASE2_GITHUB_MERGE_STATE_CONTRACT.md)
- [`docs/PHASE2_GITHUB_POLICY_EVIDENCE.md`](docs/PHASE2_GITHUB_POLICY_EVIDENCE.md)
- [`docs/PHASE2_RECONCILIATION_DURABILITY.md`](docs/PHASE2_RECONCILIATION_DURABILITY.md)
- [`docs/PHASE2_ASYNC_SAFETY.md`](docs/PHASE2_ASYNC_SAFETY.md)
- [`docs/PHASE2_GITHUB_APP_AUTH_CONTRACT.md`](docs/PHASE2_GITHUB_APP_AUTH_CONTRACT.md)
- [`docs/PHASE2_GITHUB_REST_READ_TRANSPORT.md`](docs/PHASE2_GITHUB_REST_READ_TRANSPORT.md)
- [`docs/PHASE2_GITHUB_APP_SESSION.md`](docs/PHASE2_GITHUB_APP_SESSION.md)
- [`docs/PHASE2_GITHUB_APP_ROLLOUT_PLAN.md`](docs/PHASE2_GITHUB_APP_ROLLOUT_PLAN.md)
- [`docs/PHASE2_GITHUB_GRAPHQL_MERGE_STATE_TRANSPORT.md`](docs/PHASE2_GITHUB_GRAPHQL_MERGE_STATE_TRANSPORT.md)
- [`docs/PHASE2_COMMIT_STATUS_EVIDENCE_COVERAGE.md`](docs/PHASE2_COMMIT_STATUS_EVIDENCE_COVERAGE.md)
- [`docs/PHASE2_GITHUB_AUTHORITATIVE_READ_PROVIDER.md`](docs/PHASE2_GITHUB_AUTHORITATIVE_READ_PROVIDER.md)

## Bootstrap runtime

The executable foundation provides:

- React + TypeScript + Vite;
- Cloudflare Vite plugin;
- native Cloudflare Worker API;
- deterministic `GET /api/health` endpoint;
- generated Worker types through Wrangler;
- locked dependencies;
- read-only GitHub CI for policy checks, runtime dependency audit, typecheck, typed production-source Promise lint, unit tests, build and Wrangler dry-run.

There is intentionally **no deploy script** and no Cloudflare account, route, Access, D1, Queue, Workflow or GitHub App binding in the current configuration.

### Local validation

Requires Node.js `>=22.12.0`.

```bash
npm ci
npm run check
```

For local development:

```bash
npm run dev
```

`worker-configuration.d.ts` is generated by `wrangler types` and is intentionally not committed.

## Planned platform

- React + TypeScript + Vite;
- Cloudflare Vite plugin + Workers Static Assets;
- Cloudflare Worker API;
- Cloudflare Access for human authentication;
- D1 for structured control state;
- Queues + DLQ for webhook reconciliation;
- Workflows only where durable waits/state machines add value.

The initial design targets Cloudflare Free-compatible components where practical. Paid AI/Sandbox infrastructure is deferred.

## Repository map

- [`AGENTS.md`](AGENTS.md) — mandatory worker/assistant rules;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution and PR workflow;
- [`SECURITY.md`](SECURITY.md) — security policy;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system boundaries and component architecture;
- [`docs/STATE_MODEL.md`](docs/STATE_MODEL.md) — deterministic task/approval state contract;
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats and required mitigations;
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phase gates and exit criteria;
- [`docs/PHASE1_UI_NOTES.md`](docs/PHASE1_UI_NOTES.md) — Phase 1 read-only/mobile verification contract;
- [`docs/PHASE2_GITHUB_READ_CONTRACT.md`](docs/PHASE2_GITHUB_READ_CONTRACT.md) — Phase 2 source-only GitHub read/reconciliation contract;
- [`docs/PHASE2_GITHUB_PROJECTION_CONTRACT.md`](docs/PHASE2_GITHUB_PROJECTION_CONTRACT.md) — authoritative projection/CI/review parity contract;
- [`docs/PHASE2_GITHUB_MERGE_STATE_CONTRACT.md`](docs/PHASE2_GITHUB_MERGE_STATE_CONTRACT.md) — exact-head GitHub merge-state readiness contract;
- [`docs/PHASE2_GITHUB_POLICY_EVIDENCE.md`](docs/PHASE2_GITHUB_POLICY_EVIDENCE.md) — ruleset/classic policy provenance contract;
- [`docs/PHASE2_RECONCILIATION_DURABILITY.md`](docs/PHASE2_RECONCILIATION_DURABILITY.md) — delivery/D1/Queue/DLQ source-only durability contract;
- [`docs/PHASE2_ASYNC_SAFETY.md`](docs/PHASE2_ASYNC_SAFETY.md) — typed production-source Promise handling contract;
- [`docs/PHASE2_GITHUB_APP_AUTH_CONTRACT.md`](docs/PHASE2_GITHUB_APP_AUTH_CONTRACT.md) — short-lived GitHub App credential and read-request source contract;
- [`docs/PHASE2_GITHUB_REST_READ_TRANSPORT.md`](docs/PHASE2_GITHUB_REST_READ_TRANSPORT.md) — bounded repository-scoped REST GET/pagination/rate-limit transport contract;
- [`docs/PHASE2_GITHUB_APP_SESSION.md`](docs/PHASE2_GITHUB_APP_SESSION.md) — source-only JWT, installation-token exchange and authorized-session boundary;
- [`docs/PHASE2_GITHUB_APP_ROLLOUT_PLAN.md`](docs/PHASE2_GITHUB_APP_ROLLOUT_PLAN.md) — exact selected-repository and staged read-permission/canary rollout contract;
- [`docs/PHASE2_GITHUB_GRAPHQL_MERGE_STATE_TRANSPORT.md`](docs/PHASE2_GITHUB_GRAPHQL_MERGE_STATE_TRANSPORT.md) — bounded fixed-query GraphQL merge-state transport/session contract;
- [`docs/PHASE2_COMMIT_STATUS_EVIDENCE_COVERAGE.md`](docs/PHASE2_COMMIT_STATUS_EVIDENCE_COVERAGE.md) — observed-vs-unrequested commit-status evidence and fail-closed CI semantics;
- [`docs/PHASE2_GITHUB_AUTHORITATIVE_READ_PROVIDER.md`](docs/PHASE2_GITHUB_AUTHORITATIVE_READ_PROVIDER.md) — source-only concrete GitHub provider composition, endpoint/permission binding and observation-time contract;
- [`docs/adr/`](docs/adr/) — durable architecture decisions.

## Development rule

Before every task:

1. re-read master issue #1;
2. identify the current phase and first incomplete exit criterion;
3. inspect repository instructions and current diff/state;
4. work only that scope and necessary prerequisites;
5. validate narrowly first, then broader as required;
6. use a task branch and Draft PR;
7. never interpret merge as production authorization.

No secrets belong in this public repository.