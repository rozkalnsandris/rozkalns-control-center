# Rozkalns Control

Mobile-first control and approval plane for Andris' engineering projects.

> **Status:** Phase 2 live read-only GitHub integration — source-only durability preflight is in progress through issue #21 / PR #22. No live GitHub App, Cloudflare production binding, RPi5 mutation or deployment is authorized by the current work.

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
- latest effective commit-status selection per case-insensitive context;
- latest-effective review aggregation with explicit policy requirements;
- exact-head `MERGEABLE/CLEAN` readiness gate;
- branch-policy provenance across active rulesets and classic branch protection;
- classic branch-protection `app_id`, approval and complex-review semantics;
- fail-closed webhook HMAC verification where repository identity is derived from the same authenticated payload;
- delivery-ID deduplication abstraction and reconciliation triggers requiring a fresh authoritative GitHub read;
- versioned minimal reconciliation Queue-message contract with unknown-field rejection;
- explicit durable delivery lifecycle and terminal `DEAD_LETTERED` state;
- source-controlled initial D1 migration with `delivery_id` primary-key idempotency and no secret/payload columns;
- documented future endpoint → minimum GitHub App permission requirements, including `Commit statuses: read` only when live status reads are actually introduced.

Phase 2 application projection still exposes only `OPEN_PR`; it does **not** expose a live Merge mutation.

There are still **no live GitHub API calls, credentials, dedicated Control GitHub App installation, D1/Queue/Workflow bindings or production deploy path** in the current repository.

The current `RPi5_main` automation program remains in Phase 3. CV recovery and the cross-repository evidence-directory contract are complete. Its first incomplete gate is host installation/proof of the reviewed #140 controller/readiness artifacts with the recurring timer still disabled/inactive, so Control live rollout remains separately gated and requires a fresh sequencing reconciliation at the exact rollout step.

See:

- [`docs/PHASE2_GITHUB_READ_CONTRACT.md`](docs/PHASE2_GITHUB_READ_CONTRACT.md)
- [`docs/PHASE2_GITHUB_PROJECTION_CONTRACT.md`](docs/PHASE2_GITHUB_PROJECTION_CONTRACT.md)
- [`docs/PHASE2_GITHUB_MERGE_STATE_CONTRACT.md`](docs/PHASE2_GITHUB_MERGE_STATE_CONTRACT.md)
- [`docs/PHASE2_GITHUB_POLICY_EVIDENCE.md`](docs/PHASE2_GITHUB_POLICY_EVIDENCE.md)
- [`docs/PHASE2_RECONCILIATION_DURABILITY.md`](docs/PHASE2_RECONCILIATION_DURABILITY.md)

## Bootstrap runtime

The executable foundation provides:

- React + TypeScript + Vite;
- Cloudflare Vite plugin;
- native Cloudflare Worker API;
- deterministic `GET /api/health` endpoint;
- generated Worker types through Wrangler;
- locked dependencies;
- read-only GitHub CI for policy checks, runtime dependency audit, typecheck, lint, unit tests, build and Wrangler dry-run.

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
