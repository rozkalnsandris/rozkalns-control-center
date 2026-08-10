# Delivery Roadmap

This roadmap mirrors master issue #1 but is repository-local so implementation workers can inspect phase gates without depending on chat history. If this file and master issue #1 differ, master issue #1 wins until the repository document is reconciled.

## Phase 0 — repository + contracts

Goal: create a safe, understandable codebase before any live integration.

**Status:** complete on merge of PR #5. Contract evidence is PR #3; executable/CI evidence is PR #5 and its successful GitHub-hosted validation run.

### Deliverables

- [x] concise README linked to master #1;
- [x] `AGENTS.md`;
- [x] `CONTRIBUTING.md`;
- [x] `SECURITY.md`;
- [x] architecture document;
- [x] threat model;
- [x] deterministic state model;
- [x] ADR baseline;
- [x] issue/PR templates;
- [x] React + TypeScript + Vite + Cloudflare Worker skeleton;
- [x] CI for dependency install, runtime audit, typecheck, lint, unit tests, build and Wrangler dry-run;
- [x] secret/action safety checks appropriate to a public repository.

### Must not do

- no Cloudflare production deployment;
- no new GitHub App installation/permission mutation;
- no RPi5 mutation;
- no AI API/Sandbox integration;
- no production DB or credential changes.

### Exit gate

- [x] contracts are merged and non-contradictory;
- [x] application skeleton builds/tests in authoritative GitHub CI;
- [x] repository has a deterministic contribution workflow;
- [x] no production integration was introduced.

## Phase 1 — mobile-first read-only UI

Goal: prove the Android-first UX before live GitHub writes.

**Status:** complete on merge of PR #7. Implementation evidence is issue #6 / PR #7; accessibility and fixture safety contract is `docs/PHASE1_UI_NOTES.md`.

### Deliverables

- [x] project overview;
- [x] PR/CI/review read models using deterministic fixtures;
- [x] `Needs Andris` queue;
- [x] decision card layout;
- [x] working/waiting/failed and merge-ready states;
- [x] responsive/mobile-first layout;
- [x] Samsung Galaxy A55-class compact portrait contract without device sniffing/physical-pixel hardcoding;
- [x] accessibility checks for touch targets, visible focus, skip navigation and text-based status meaning;
- [x] explicit fixture-mode safety so mock actions cannot be mistaken for live mutations.

### Must not do

- [x] no GitHub writes;
- [x] no live production mutation;
- [x] no AI execution.

### Exit gate

- [x] phone-first layout surfaces `Needs Andris` before secondary states;
- [x] mocked PR decisions include enough CI/review/SHA/deploy evidence to understand why a human is needed;
- [x] primary mock controls meet the Android-oriented >=48px touch-target goal;
- [x] status meaning is not color-only and keyboard focus remains visible;
- [x] fixture/model/UI/compact-phone tests are part of normal CI;
- [x] no live GitHub/production write path was introduced.

## Phase 2 — live read-only GitHub integration

Goal: replace fixtures with trustworthy live GitHub state.

**Status:** CURRENT — source-only preflight in issue #8. Live GitHub App/Cloudflare rollout remains gated.

### Sequencing prerequisite

The current authoritative `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md` was re-read before #8. RPi5 automation remains in Phase 3 — CV pull-deploy migration with incomplete maintenance/CV-health/controller gates.

Therefore source-only interfaces, schemas, pure crypto/reconciliation code, tests and docs may proceed, but live GitHub App installation/permission changes, Cloudflare production bindings or RPi5 integration require a fresh reconciliation at the exact rollout step.

Do not reuse or broaden the existing `Rozkalns Automation` RPi5 verifier App.

### Source-only preflight deliverables — issue #8

- [x] configuration-driven managed-repository allow-list source model;
- [x] provider-neutral source-control read interface with no mutation methods;
- [x] exact-head PR/check/workflow evidence binding;
- [x] raw GitHub webhook header/HMAC verification source contract;
- [x] delivery-claim/deduplication persistence interface with deterministic in-memory test implementation;
- [x] reconciliation trigger requiring authoritative GitHub reread;
- [x] planned REST endpoint → minimum GitHub App permission documentation;
- [x] focused tests for allow-list, HMAC vector, missing/malformed auth metadata, duplicate delivery and stale SHA evidence;
- [ ] authoritative GitHub CI PASS on final #8 branch head;
- [ ] #8 reviewed and merged.

### Later Phase 2 live deliverables — separately gated

- [ ] dedicated `Rozkalns Control` GitHub App;
- [ ] exact minimum read permissions and selected repositories only;
- [ ] short-lived installation-token boundary;
- [ ] live GitHub read adapter;
- [ ] authenticated webhook route using raw-body HMAC validation;
- [ ] durable delivery deduplication;
- [ ] Queue + DLQ reconciliation;
- [ ] live issues/PR/review/CI projections;
- [ ] fixture/live adapter parity tests;
- [ ] observable reconciliation/DLQ failures.

### Must not do

- no GitHub source writes;
- no Merge button mutation yet;
- no RPi5 mutation;
- no production deployment implied by integration work;
- no AI execution.

### Exit gate

Live dashboard state matches GitHub deterministically, invalid/replayed events fail safely, and event loss is visible through DLQ/error state while no GitHub write permission/path exists.

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
