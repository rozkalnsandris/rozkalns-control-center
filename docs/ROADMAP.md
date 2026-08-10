# Delivery Roadmap

This roadmap mirrors master issue #1 but is repository-local so implementation workers can inspect phase gates without depending on chat history. If this file and master issue #1 differ, master issue #1 wins until the repository document is reconciled.

## Phase 0 — repository + contracts

Goal: create a safe, understandable codebase before any live integration.

### Deliverables

- [ ] concise README linked to master #1;
- [ ] `AGENTS.md`;
- [ ] `CONTRIBUTING.md`;
- [ ] `SECURITY.md`;
- [ ] architecture document;
- [ ] threat model;
- [ ] deterministic state model;
- [ ] ADR baseline;
- [ ] issue/PR templates;
- [ ] React + TypeScript + Vite + Cloudflare Worker skeleton;
- [ ] CI for typecheck, lint, unit tests and build;
- [ ] secret/action safety checks appropriate to a public repository.

### Must not do

- no Cloudflare production deployment;
- no new GitHub App installation/permission mutation;
- no RPi5 mutation;
- no AI API/Sandbox integration;
- no production DB or credential changes.

### Exit gate

Phase 0 exits only when:

- contracts are merged and non-contradictory;
- application skeleton builds/tests locally/CI;
- repository has a deterministic contribution workflow;
- no production integration was introduced.

## Phase 1 — mobile-first read-only UI

Goal: prove the Android-first UX before live GitHub writes.

### Deliverables

- project overview;
- PR/CI/review read models using deterministic fixtures;
- `Needs Andris` queue;
- decision card layout;
- working/waiting/failed states;
- responsive and accessibility checks.

### Must not do

- no GitHub writes;
- no live production mutation;
- no AI execution.

### Exit gate

A phone user can understand the state/reason for a mocked real-world PR decision without opening multiple systems.

## Phase 2 — live read-only GitHub integration

Goal: replace fixtures with trustworthy live GitHub state.

Prerequisite: reconcile this integration with the active `RPi5_main` automation phase.

### Deliverables

- dedicated `Rozkalns Control` GitHub App;
- minimum read permissions and selected repos only;
- GitHub webhook raw-body HMAC validation;
- delivery deduplication;
- Queue + DLQ reconciliation;
- live issues/PR/review/CI projections;
- source-of-truth re-resolution patterns.

### Must not do

- no GitHub source writes;
- no Merge button mutation yet;
- no RPi5 mutation;
- no AI execution.

### Exit gate

Live dashboard state matches GitHub deterministically, invalid/replayed events fail safely, and event loss is visible through DLQ/error state.

## Phase 3 — human decision actions

Goal: make `Needs Andris` genuinely useful.

### Deliverables

- authenticated `Merge`;
- `Needs changes`/request-change flow;
- `Later` defer flow;
- stale-head approval binding;
- live CI/review revalidation before writes;
- expected-head merge protection where supported;
- idempotency/audit records;
- optional `Retry CI` only if exact permission/semantics are proven.

### Must not do

- no production deploy action implied by Merge;
- no DB/host/root action;
- no broad GitHub App source-write permission;
- no AI coding runtime.

### Exit gate

A real PR can be safely decided from phone; stale approvals are rejected; action evidence is auditable; Merge cannot bypass CI/review policy.

## Phase 4 — notifications + deterministic continuation

Goal: reduce user interaction to meaningful gates.

### Deliverables

- Telegram and/or web push;
- deep link to exact decision card;
- transition-based deduplication/noise control;
- project/campaign pause controls where safe;
- deterministic next-eligible task/campaign state;
- pilot of ChatGPT Scheduled Task + connected GitHub app background bridge.

### Pilot rule

Do not assume Scheduled Tasks can perform unattended GitHub writes. Prove the required action set in the real account. If unsupported, keep the bridge read/notify/continue-state only.

### Exit gate

A real workflow can reach `Needs Andris`, notify once, accept a decision, record it and move to a deterministic next state without old chat memory.

## Phase 5 — production visibility

Goal: show production truth without weakening production boundaries.

### Deliverables

- sanitized read-only RPi5 adapter;
- GitHub main SHA vs production SHA;
- deploy class;
- runtime/health/rollback evidence projection;
- drift/blocker display.

### Must not do

- no direct SSH/sudo mutation from Control Center;
- no production DB writes;
- no bypass of `RPi5_main` controller/helper gates.

### Exit gate

Control Center accurately explains production readiness/drift while all mutations remain owned by the existing production control plane.

## Final optional phase — AI/agent runtime

Only after the approval/control product is proven valuable.

Possible scope:

- provider-neutral agent interface;
- OpenAI/Codex and/or Claude adapter;
- optional Cloudflare AI Gateway;
- isolated sandbox execution;
- hard budget controls;
- bounded source-edit/PR automation;
- provider switching without UI redesign.

Requirements before enabling:

- updated threat model;
- explicit cost ceilings;
- isolated execution design;
- no production credentials in agent runtime;
- new permissions reviewed independently.
