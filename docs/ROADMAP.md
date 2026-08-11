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

**Status:** CURRENT — source-only safety/correctness/durability/async/auth/evidence/REST/GraphQL/session/rollout contracts are complete through issue #37 / PR #39; current issue #40 / PR #41 hardens conditional commit-status evidence coverage before the concrete provider adapter. Live GitHub App/credential/Cloudflare rollout remains separately gated.

### Sequencing prerequisite

The current authoritative `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md`, completed issue #163 and open issue #140 were re-read during current Phase 2 work on 2026-08-11. RPi5 automation remains in Phase 3 — CV pull-deploy migration. Issue #163 is complete: the classifier/control-plane and production baselines are reconciled to exact `rozkalns-cv/main=4a0069a97022841da07a687a197ea8cfacc56cd6`.

The current first incomplete RPi5 gate belongs to #140: wait for a genuinely newer exact-current-main CV delta after that baseline, require fresh exact-current-main CI, require the complete production-to-target range to classify `AUTO_DEPLOY_SAFE` with `CONTROL_PLANE_CHANGED=false`, and only then separately review/authorize exactly one one-shot controller execution canary while the recurring timer remains disabled/inactive.

Therefore source-only interfaces, schemas, migrations, crypto/reconciliation/projection/merge-state/policy/evidence/auth/transport/session/rollout-plan code, tests and docs may proceed, but real GitHub App installation/permission changes, real credential minting, Cloudflare secret/bindings/resources or RPi5 integration require a separate owner authorization and fresh sequencing reconciliation at the exact rollout step.

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
- [x] authoritative GitHub CI PASS after code/docs reconciliation;
- [x] #19 reviewed and merged through PR #20 as `9e56fc5cab4f61bcd3ee48df7a4c8865fc6d058b`.

### Source-only reconciliation durability — issue #21 / PR #22

- [x] add versioned minimal `GITHUB_RECONCILIATION` Queue-message contract;
- [x] reject unknown Queue schema versions/kinds/fields and non-authoritative messages;
- [x] bind message repository/project identity to the managed-project allow-list;
- [x] define explicit durable delivery lifecycle `RECEIVED -> ENQUEUED -> PROCESSING -> SUCCEEDED/RETRY_PENDING/DEAD_LETTERED`;
- [x] make success/dead-letter terminal and require sanitized error codes for retry/dead-letter transitions;
- [x] add source-controlled `migrations/0001_reconciliation_core.sql` with `delivery_id` primary-key idempotency;
- [x] persist attempt/timestamp/state/error-code observability without webhook body, tokens, secrets or private keys;
- [x] source-boundary proves no D1/Queue binding, handler, `fetch()` transport or `env.*` access exists;
- [x] first authoritative GitHub CI run #49 PASS on source/tests implementation;
- [x] document durability, DLQ observability and current RPi sequencing contract;
- [x] authoritative GitHub CI PASS after docs reconciliation — run #52;
- [x] #21 reviewed and merged through PR #22 as `47cc58e5815159203e0822de42b3e0a47f442047`.

### Source-only async Promise safety — issue #23 / PR #25

- [x] enable type-aware ESLint Project Service for production `src/**/*.{ts,tsx}`;
- [x] enforce `@typescript-eslint/no-floating-promises` as an error before live async handlers exist;
- [x] keep `node:test` registration code outside this production runtime rule rather than adding blanket suppressions;
- [x] preserve existing non-type-checked recommended lint for tests and JavaScript utility scripts;
- [x] regression-lock the runtime-source glob, Project Service and floating-Promise rule in `tests/eslint-config.test.ts`;
- [x] first typed-lint attempt failed closed because tests were outside a Project Service `tsconfig.json`;
- [x] second typed-lint attempt proved the rule active but exposed only 58 `node:test` registration calls, leading to the narrower production-source scope instead of suppressions;
- [x] authoritative GitHub CI run #59 PASS after source scoping, with typed lint, unit tests, build and Wrangler dry-run green;
- [x] document runtime Promise handling and async-safety rationale;
- [x] final authoritative GitHub CI PASS on exact final head — run #63;
- [x] #23 reviewed and merged through PR #25 as `2030c9c93c0e8e6348c0b5381792eb57964ef391`.

### Source-only GitHub App installation auth/read transport — issue #26 / PR #27

- [x] define selected managed-repository installation read scope with case-insensitive duplicate rejection;
- [x] allow only the Phase 2 read-permission subset and fail closed on write access;
- [x] keep `administration` outside the approved source contract pending a separate canary/owner gate;
- [x] model only sanitized credential lease evidence; raw credential material is absent from domain/business interfaces;
- [x] enforce short-lived lease lifetime and a minimum remaining-lifetime safety margin;
- [x] make installation-token format opaque with no prefix/length assumptions;
- [x] define a repository/permission/version-bound REST read request with no caller-supplied auth header or write method;
- [x] place future GitHub integration contracts under `src/integrations/github` and include them in Worker/test typechecking;
- [x] source-boundary tests prove no live GitHub host, HTTP implementation or credential source was introduced;
- [x] first authoritative GitHub CI run #65 PASS on source/tests implementation;
- [x] document the GitHub App auth/read-transport contract and current RPi sequencing boundary;
- [x] authoritative GitHub CI PASS after docs reconciliation — run #68;
- [x] exact final-head GitHub CI PASS — run #69;
- [x] #26 reviewed and merged through PR #27 as `a5f6c0e5a2a42172dc945247d51cb38bd50ce196`.

### Source-only latest-effective CI rerun evidence — issue #28 / PR #29

- [x] add documented optional ordering evidence for Check Runs and workflow runs;
- [x] validate provided ordering fields while treating missing ordering evidence as ambiguous rather than guessed;
- [x] select latest provable Check evidence per case-insensitive context + producer App;
- [x] keep different Check producer Apps separate;
- [x] normalize commit statuses latest-per-case-insensitive-context inside projection as a second safety layer;
- [x] select latest provable workflow evidence by known workflow identity, run number, run attempt and documented timestamps;
- [x] never collapse missing workflow identity merely because display names match;
- [x] preserve ambiguous/equal/unorderable evidence simultaneously so it can block `PASS`;
- [x] make `aggregateCiState()` normalize latest-effective evidence even when a future provider supplies duplicates;
- [x] regression tests cover old-fail/new-success, old-success/new-running, producer separation, workflow reruns, ambiguous ordering and stale heads;
- [x] source-boundary includes the evidence selector and remains free of live transport/mutation paths;
- [x] first authoritative GitHub CI run #71 PASS on source/tests implementation;
- [x] reconcile README, projection contract and ROADMAP with #27 merged baseline and #28 evidence semantics;
- [x] authoritative GitHub CI PASS after docs reconciliation — run #74;
- [x] exact final-head GitHub CI PASS — run #75;
- [x] #28 reviewed and merged through PR #29 as `d414a34e04ffff36b904a4ab1562cc0025f5df71`.

### Source-only bounded GitHub REST read transport — issue #30 / PR #31

- [x] start the branch from exact post-PR-#29 `main=d414a34e04ffff36b904a4ab1562cc0025f5df71`;
- [x] keep the concrete transport under the dedicated `src/integrations/github` boundary;
- [x] use a fixed `https://api.github.com` origin with GET-only, integration-owned media type/API version and manual redirect handling;
- [x] revalidate managed repository, approved read permission and sanitized credential lease before transport;
- [x] follow only validated same-origin/same-repository `Link` `rel="next"` evidence sequentially;
- [x] reject off-origin/cross-repository/traversal pagination, duplicate/malformed next links and pagination cycles;
- [x] enforce a local request budget with a source-controlled hard cap;
- [x] preserve endpoint-specific response pages instead of generically merging payload shapes;
- [x] parse only sanitized `x-ratelimit-*` evidence and expose retry-not-before timing without an automatic retry loop;
- [x] distinguish rate-limited, unauthorized, forbidden, not-found, malformed, boundary/budget and unexpected-status outcomes fail closed;
- [x] keep credential-provider/network details out of public error strings and raw credential material out of source/tests/docs;
- [x] keep `src/worker/index.ts` disconnected from the transport; no live GitHub request route exists;
- [x] deterministic fake-session regressions cover one/multiple pages, absent Link, hostile links, cycles/budget, auth statuses, primary/secondary limits, malformed headers/content and transport failures;
- [x] first CI attempt #77 failed closed at TypeScript because the generic transport method parameters needed explicit annotations;
- [x] corrected source/test exact-head CI #78 PASS with policy, runtime audit, typecheck, typed lint, unit tests, build and Wrangler dry-run green;
- [x] add focused transport documentation and reconcile README/ROADMAP with the merged #29 baseline and current RPi5 #163 sequencing gate;
- [x] exact final-head GitHub CI PASS after docs reconciliation — run #81;
- [x] #30 reviewed and merged through PR #31 as `e02093510afaa7decd88bfc753ee585a3a3ad676`.

### Source-only GitHub App JWT / installation session — issue #32 / PR #33

- [x] start the branch from exact current `main=2cf8cac5b63cd87599a027ad3eb5d39a32fb8872` after the disclosed no-op cleanup reconciliation;
- [x] define non-secret GitHub App client-ID identity and a narrow `signRs256()` abstraction with no PEM/private-key representation in the public contract;
- [x] build deterministic `RS256` JWT signing input with 60-second clock-skew backdating and a 9-minute future expiry;
- [x] fix token exchange to `POST /app/installations/{installation_id}/access_tokens` under the trusted GitHub REST origin;
- [x] explicitly narrow every token request to the validated repository names and approved read-only permission map;
- [x] parse returned repository/permission evidence and require exact scope equivalence before accepting the lease;
- [x] reuse the existing short-lived credential lease parser/usability gate for expiry and remaining lifetime;
- [x] keep installation-token value opaque with no prefix or length assumption;
- [x] retain raw JWT/token material only inside the dedicated integration layer and authorized-session closure;
- [x] compose the authorized session with the merged #31 bounded REST GET transport while keeping Bearer credentials out of returned models;
- [x] reject off-origin/out-of-scope authorized reads before authenticated HTTP;
- [x] map signing/token endpoint/response/read failures to fixed sanitized typed outcomes;
- [x] source-boundary proves Worker/shared/domain code has no JWT/token/Authorization primitive and Wrangler has no secret/var binding;
- [x] CI #85 proved policy/audit/typecheck then failed closed on `no-control-regex`; production validation was rewritten without a lint suppression;
- [x] CI #86 passed policy/audit/typecheck/lint and exposed only a test TypeScript nullability issue;
- [x] CI #87 passed policy/audit/typecheck/lint and exposed only an opaque-token test false positive;
- [x] corrected source/test exact-head CI #88 PASS with policy, runtime audit, typecheck, typed lint, all unit tests, build and Wrangler dry-run green;
- [x] add focused GitHub App session documentation and reconcile README/ROADMAP with #31 merged baseline and then-current RPi5 #163 gate;
- [x] exact final-head GitHub CI PASS after docs reconciliation — run #91;
- [x] #32 reviewed and merged through PR #33 as `5e6e4dbcc59207691bc2bae2c88e1c9b82d57f4f`.

### Source-only GitHub App rollout/canary plan — issue #34 / PR #36

- [x] start the branch from exact post-PR-#33 `main=5e6e4dbcc59207691bc2bae2c88e1c9b82d57f4f`;
- [x] fix the future App identity to `Rozkalns Control` and repository-selection mode to selected repositories;
- [x] derive the exact selected repository set from enabled `githubReadEnabled` managed-project policy instead of duplicating a second allow-list;
- [x] prove the six intended repositories are selected and `rozkalnsandris/hermes-email-skill` remains excluded;
- [x] begin with a Metadata-only stage covering repository metadata and active branch-rules canaries;
- [x] define cumulative read-only stages for Contents, Issues, Pull requests, Checks and Actions;
- [x] keep the planned GraphQL merge-state canary explicit under the Pull requests stage without adding a live GraphQL transport;
- [x] make `statuses: read` conditional on explicit `LEGACY_COMMIT_STATUS_REQUIRED` repository evidence;
- [x] keep `administration` and all write access unrepresentable by the rollout source contract;
- [x] build exact-stage installation scopes through the existing fail-closed `parseGitHubInstallationReadScope()` contract;
- [x] source-boundary tests prove the rollout manifest contains no GitHub HTTP/auth/secret/Worker mutation path;
- [x] CI #93 failed closed at TypeScript on literal tuple-length narrowing; the runtime integrity check was preserved with a widened interface view;
- [x] corrected source/test exact-head CI #94 PASS with policy, runtime audit, typecheck, typed lint, all unit tests, build and Wrangler dry-run green;
- [x] add focused rollout-plan documentation and reconcile README/ROADMAP with #33 merged baseline, completed RPi5 #163 and current RPi5 #140 gate;
- [x] exact final-head GitHub CI PASS after docs reconciliation — run #97;
- [x] #34 reviewed and merged through PR #36 as `44f557518e298e57488aac9d3a8df7184f8d9d99`.

### Source-only bounded GitHub GraphQL merge-state transport — issue #37 / PR #39

- [x] start the branch from exact post-PR-#36 `main=44f557518e298e57488aac9d3a8df7184f8d9d99`;
- [x] fix the endpoint to `https://api.github.com/graphql` and expose only one named pull-request merge-state query;
- [x] pass dynamic repository owner/name and positive pull number only as GraphQL variables;
- [x] limit selected fields to `number`, `headRefOid`, `mergeable`, `mergeStateStatus`, `isDraft`;
- [x] require managed repository scope plus `pull_requests: read` before credential acquisition;
- [x] keep arbitrary GraphQL documents, introspection and mutation operations unrepresentable;
- [x] reuse the #32 private credential-acquisition path while keeping REST GET and GraphQL POST sessions as separate narrow interfaces;
- [x] keep raw installation credentials internal to the integration session closure;
- [x] reject any GraphQL `errors` envelope even when partial data is present;
- [x] map only the validated pull-request node through the existing #12 fail-closed mapper and require exact returned PR number;
- [x] parse sanitized GraphQL rate-limit headers and recognize HTTP-200 primary/secondary rate-limit evidence without an automatic retry loop;
- [x] fail closed on missing repository/PR, malformed response/header/content, auth/permission, transport and unexpected-status outcomes;
- [x] source-boundary tests prove Worker/shared code has no GraphQL endpoint/auth/mutation path and REST transport remains GET-only;
- [x] source/test exact-head CI #99 PASS with policy, runtime audit, typecheck, typed lint, all unit tests, build and Wrangler dry-run green;
- [x] add focused GraphQL transport documentation and reconcile README/ROADMAP with #36 merged baseline and current RPi5 #140 gate;
- [x] exact final-head GitHub CI PASS after docs reconciliation — run #102;
- [x] #37 reviewed and merged through PR #39 as `d1854293fe4fdc3ba42fad48d0908627c4941bf9`.

### Source-only conditional commit-status evidence coverage — issue #40 / PR #41

- [x] start the branch from exact post-PR-#39 `main=d1854293fe4fdc3ba42fad48d0908627c4941bf9`;
- [x] distinguish `OBSERVED` from `NOT_REQUESTED` commit-status evidence in authoritative snapshots;
- [x] keep existing callers defaulted to `OBSERVED` so the new contract cannot silently weaken current reads;
- [x] make explicit `NOT_REQUESTED` skip `listCommitStatuses()` and return an empty, unobserved status array;
- [x] prevent a successful Check from producing CI `PASS` for a required status-check context while commit statuses were not requested;
- [x] preserve observed Check `FAIL` and `RUNNING` precedence when the status source is unrequested;
- [x] allow workflow-only policy to evaluate independently when no required status-check contexts exist;
- [x] reject contradictory `NOT_REQUESTED` snapshots that contain commit-status evidence;
- [x] preserve exact-head validation for all commit statuses that are present;
- [x] add deterministic provider-call, aggregation, projection and source-boundary regressions;
- [x] CI #104 failed closed only because an existing projection test fixture did not declare the new required coverage field;
- [x] correct that fixture to explicit `OBSERVED` without weakening production types;
- [x] corrected source/test exact-head CI #105 PASS with policy, runtime audit, typecheck, typed lint, all unit tests, build and Wrangler dry-run green;
- [x] add focused coverage documentation and reconcile ROADMAP with #39 merged baseline and current RPi5 #140 gate;
- [ ] exact final-head GitHub CI PASS after docs reconciliation;
- [ ] #40 final branch reviewed and merged.

### Later Phase 2 live deliverables — separately gated

- [ ] dedicated `Rozkalns Control` GitHub App;
- [ ] exact minimum read permissions and selected repositories only;
- [ ] execute the reviewed rollout plan only one separately approved permission stage at a time;
- [ ] live canary proving the exact GraphQL/REST permission set rather than assuming it;
- [ ] canary `GET /rules/branches/{branch}` with Metadata-read before proposing any `Administration: read` expansion;
- [ ] add/canary Repository `Commit statuses: read` only if actual managed repositories require commit-status evidence;
- [ ] if still required after the Metadata-read canary, separately review/authorize an `Administration: read` classic-protection canary;
- [ ] distinguish authorized classic-protection absence from permission/not-found ambiguity before treating classic coverage as observed-and-empty;
- [ ] add an approved Cloudflare secret/private-key signer binding and prove real short-lived installation-token minting through a narrowly scoped canary;
- [ ] wire the reviewed bounded REST + GraphQL transports/sessions to an approved authoritative read-only reconciliation path;
- [ ] authenticated webhook route using raw-body HMAC validation;
- [ ] create/bind D1 and apply reviewed source-controlled migrations;
- [ ] create/bind Queue + DLQ and implement producer/consumer handlers;
- [ ] atomic durable delivery claim/transition persistence;
- [ ] live issues/PR/review/CI/merge-state projections;
- [ ] fixture/live adapter parity tests against real read-only snapshots;
- [ ] observable reconciliation/DLQ failures in the live UI/state projection.

### Must not do

- no GitHub source writes;
- no Merge button mutation yet;
- no RPi5 mutation;
- no production deployment implied by integration work;
- no AI execution.

### Exit gate

Live dashboard state matches GitHub deterministically, invalid/replayed events fail safely, and event loss is visible through durable/DLQ error state while no GitHub write permission/path exists.

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

Goal: reduce normal interaction to meaningful gates.

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