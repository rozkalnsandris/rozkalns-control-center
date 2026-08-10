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

**Status:** CURRENT — source-only safety/correctness contracts have progressed through issues #8, #10, #12, #15, #17 and current issue #19 / PR #20. Live GitHub App/Cloudflare rollout remains separately gated.

### Sequencing prerequisite

The current authoritative `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md` was re-read before issue #19. RPi5 automation remains in Phase 3 — CV pull-deploy migration. CV recovery is complete; its first incomplete gate is now the cross-repository #140 evidence-directory contract (`rozkalns-cv-auto-deploy-*` controller producer vs `rozkalns-cv-main-deploy-*` CV root-wrapper allow-list), which must be fixed and regression-proven before reviewed controller installation/execution.

Therefore source-only interfaces, schemas, crypto/reconciliation/projection/merge-state/policy/evidence code, tests and docs may proceed, but live GitHub App installation/permission changes, Cloudflare production bindings or RPi5 integration require a fresh reconciliation at the exact rollout step.

Do not reuse or broaden the existing `Rozkalns Automation` RPi5 verifier App.

### Source-only read/webhook preflight — issue #8 / PR #9

- [x] configuration-driven managed-repository allow-list source model;
- [x] provider-neutral source-control read interface with no mutation methods;
- [x] exact-head PR/check/workflow evidence binding;
- [x] raw GitHub webhook header/HMAC verification source contract;
- [x] delivery-claim/deduplication persistence interface with deterministic in-memory test implementation;
- [x] reconciliation trigger requiring authoritative GitHub reread;
- [x] planned REST endpoint → minimum GitHub App permission documentation;
- [x] focused tests for allow-list, HMAC vector, missing/malformed auth metadata, duplicate delivery and stale SHA evidence;
- [x] authoritative GitHub CI PASS after the Web Crypto compatibility fix;
- [x] #8 reviewed and merged through PR #9.

### Source-only projection/parity — issue #10 / PR #11

- [x] fail-closed mappers for only the documented GitHub REST fields currently consumed;
- [x] current pending-like check-run statuses represented without treating them as success;
- [x] exact-head check/workflow filtering and projection reassertion;
- [x] conservative required-CI aggregation; missing/ambiguous policy/evidence never becomes PASS;
- [x] conservative latest-effective-review aggregation; missing reviewer policy never becomes PASS;
- [x] authoritative snapshot projection into the existing Phase 1 `DecisionReadModel` contract;
- [x] deploy impact remains `UNKNOWN` unless supplied by a separate trusted projection;
- [x] read-only projection exposes `OPEN_PR` only, never Merge;
- [x] fixture/live structural parity and stale-head regression tests;
- [x] source-only boundary tests include the mapper/projection modules;
- [x] authoritative GitHub CI PASS on the final branch;
- [x] #10 reviewed and merged through PR #11.

### Source-only authoritative merge-state gate — issue #12 / PR #14

- [x] exact-head provider contract includes a separate pull-request merge-state read;
- [x] fail-closed mapper for the documented GitHub GraphQL merge-state fields consumed by Control;
- [x] merge-state evidence is bound to the same PR number, exact head SHA and draft state as the PR snapshot;
- [x] only `MERGEABLE/CLEAN` may satisfy the merge-state readiness gate;
- [x] `BEHIND`, `BLOCKED`, `DIRTY`, `DRAFT`, `HAS_HOOKS`, `UNKNOWN`, `UNSTABLE` remain non-ready;
- [x] unknown future merge-state enum values fail closed;
- [x] source-only boundary includes the GraphQL mapper and still proves no transport/auth/mutation path;
- [x] Repository `Administration: read` is deliberately not added merely to read branch protection;
- [x] authoritative GitHub CI PASS on the final branch;
- [x] #12 reviewed and merged through PR #14.

### Source-only branch-policy provenance — issue #15 / PR #16

- [x] model branch-policy observations with explicit source provenance;
- [x] distinguish `UNKNOWN`, `PARTIAL` and `COMPLETE` policy coverage;
- [x] map active GitHub ruleset `required_status_checks` and pull-request review requirements from consumed documented fields;
- [x] deduplicate required check contexts and combine multiple active rules conservatively;
- [x] preserve required-check `integration_id` in policy evidence;
- [x] record complex review semantics that cannot safely collapse to approval count alone;
- [x] ruleset-only evidence remains partial while classic branch protection is unverified;
- [x] reject duplicate source observations, branch/repository mismatch and mixed reconciliation timestamps;
- [x] derive CI/review policy objects only from complete and representable evidence;
- [x] document that active-rules reads need only Repository `Metadata: read` while classic branch protection needs `Administration: read`;
- [x] authoritative GitHub CI PASS on final branch;
- [x] #15 reviewed and merged through PR #16.

### Source-only classic branch-protection mapper — issue #17 / PR #18

- [x] add fail-closed mapper for consumed classic branch-protection response fields;
- [x] preserve explicit `checks[].app_id` producer identity;
- [x] normalize explicit `app_id=-1` as any-App while keeping missing `app_id` source identity unresolved;
- [x] preserve legacy `contexts` requirements without pretending their producer identity is known;
- [x] map classic required approval count, stale-review, code-owner and last-push semantics;
- [x] map required conversation resolution into the existing complex-review feature gate;
- [x] propagate unresolved required-check source identity through combined policy evidence;
- [x] keep ambiguous/complex policy fail-closed in `deriveProjectionPolicies()`;
- [x] source-boundary tests prove no live API/auth/mutation path was introduced;
- [x] authoritative GitHub CI PASS on final branch;
- [x] #17 reviewed and merged through PR #18 as `19e4e89d66bfba9218a36e5e19628ce7866c40ec`.

### Source-only status/producer/webhook correctness — issue #19 / PR #20

- [x] add provider-neutral commit-status evidence bound to the exact PR head SHA;
- [x] add fail-closed GitHub commit-status mapper for `success`, `failure`, `error`, `pending`;
- [x] deterministically keep the newest effective status for each case-insensitive context;
- [x] preserve Check Run `app.id` producer identity;
- [x] treat completed Check Run `success`, `neutral` and `skipped` as passing GitHub required-status evidence;
- [x] evaluate same required context across Check Runs and commit statuses conservatively;
- [x] carry explicit required App/integration ID into CI policy and reject wrong/unknown producer evidence;
- [x] bind commit-status evidence to the exact observed PR head SHA in authoritative reads and projection;
- [x] derive reconciliation repository identity from the HMAC-verified webhook payload instead of an independent caller hint;
- [x] regression tests cover latest status selection, case-insensitive contexts, mixed Check/status evidence, App mismatch/unknown producer, stale heads and verified webhook repo binding;
- [x] source-boundary tests prove no live GitHub transport/auth/mutation path was introduced;
- [x] first authoritative GitHub CI run #41 PASS on source/test implementation;
- [x] README/read-policy docs reconciled with current source contracts;
- [x] canonical master #1 reconciled with current Phase 2 status;
- [x] authoritative GitHub CI PASS after code/docs reconciliation — run #46;
- [ ] #19 final branch reviewed and merged.

### Later Phase 2 live deliverables — separately gated

- [ ] dedicated `Rozkalns Control` GitHub App;
- [ ] exact minimum read permissions and selected repositories only;
- [ ] live canary proving the exact GraphQL/REST permission set rather than assuming it;
- [ ] canary `GET /rules/branches/{branch}` with Metadata-read before proposing any `Administration: read` expansion;
- [ ] add/canary Repository `Commit statuses: read` only if actual managed repositories require commit-status evidence;
- [ ] if still required after the Metadata-read canary, separately review/authorize an `Administration: read` classic-protection canary;
- [ ] distinguish authorized classic-protection absence from permission/not-found ambiguity before treating classic coverage as observed-and-empty;
- [ ] short-lived installation-token boundary;
- [ ] live GitHub read adapter;
- [ ] authenticated webhook route using raw-body HMAC validation;
- [ ] durable delivery deduplication;
- [ ] Queue + DLQ reconciliation;
- [ ] live issues/PR/review/CI/merge-state projections;
- [ ] fixture/live adapter parity tests against real read-only snapshots;
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
