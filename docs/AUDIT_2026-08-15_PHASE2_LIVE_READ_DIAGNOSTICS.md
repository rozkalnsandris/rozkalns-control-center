# Audit — Phase 2 live-read diagnostics, 2026-08-15

This document is the durable audit record for the Rozkalns Control Phase 2 live read-only GitHub dashboard diagnostic campaign captured in the 2026-08-14/15 Control Panel conversation.

It records what was actually proven, what changed in source, what was observed in production, which owner authorizations were consumed, what remains unresolved, and the next safe decision boundary.

Issue: #128.

Audit cutoff: 2026-08-15 00:34 CEST.

## 1. Scope and evidence classes

This audit deliberately separates three evidence classes.

### 1.1 GitHub-verified source evidence

Source state, PR state, merge state and CI state are recorded from GitHub. At audit start:

- repository: `rozkalnsandris/rozkalns-control-center`;
- current `main`: `3f5317996d870f3814970ad99d255dd0bd5120c9`;
- exact-main CI: #230 / run `31846676406` = `completed/success`;
- latest merged source change: PR #127 `fix: expose bounded GitHub transport stages`;
- current diagnostic repository: `rozkalnsandris/hermes-deals`;
- diagnostic issue #631: open;
- diagnostic PR #650: open, non-draft and mergeable;
- diagnostic PR exact head: `29681f0388f6289dde758f7bd6a4256b271a64e2`.

### 1.2 Owner-provided production evidence

Cloudflare production version/deployment ids, canary outputs and authorization-consumption markers are recorded only where the owner pasted the command output into the conversation.

The last directly proven production runtime at the audit cutoff is:

- Worker: `rozkalns-control`;
- account id: `70e29dbca0e8363358659102d2b74178`;
- hostname: `control.rozkalns.net`;
- active version: `0155bfca-c460-4c8e-ae23-679db3611b22`;
- active deployment: `5fc8db80-0227-42d8-a48f-890fcf83eb98`;
- traffic: `100%`;
- Custom Domain id: `ac685929d45e825df5b5f6b803a9814b6dbf5d9d`;
- D1 binding: `CONTROL_DB` → `rozkalns-control-production`;
- `GITHUB_APP_CLIENT_ID=Iv23likDoFtVeWBJfdFS`;
- `GITHUB_APP_INSTALLATION_ID=153121564`;
- `CONTROL_LIVE_READ_ENABLED=true`;
- required secret binding present;
- Access protection preserved;
- protected `/api/health` canary passes;
- workers.dev disabled;
- preview URLs disabled;
- current reconciliation result: `GITHUB_TRANSPORT_FAILED`;
- current reconciliation stage: not available on this deployed version.

### 1.3 Pending authorization evidence

An owner authorization may exist without the corresponding production mutation having happened yet.

At this audit cutoff the newest one-shot Phase 2 diagnostic redeploy authorization has been granted, but no execution result for it has been pasted into the conversation. Therefore the audited state is:

`AUTHORIZED_PENDING_EXECUTION`

and not `DEPLOYED`, not `CONSUMED`, and not `FAILED`.

The authorization is bound to:

- exact main: `3f5317996d870f3814970ad99d255dd0bd5120c9`;
- exact-main CI run: `31846676406`;
- current production version: `0155bfca-c460-4c8e-ae23-679db3611b22`;
- current production deployment: `5fc8db80-0227-42d8-a48f-890fcf83eb98`;
- domain id: `ac685929d45e825df5b5f6b803a9814b6dbf5d9d`;
- diagnostic issue: `631`;
- diagnostic PR: `650`;
- diagnostic PR head: `29681f0388f6289dde758f7bd6a4256b271a64e2`.

The exact authorization must be treated as consumed only if an execution log later proves `DEPLOY_STARTED=YES`.

## 2. Permanent workflow and safety contract

The workflow throughout this campaign is:

`issue → fresh branch → focused changes → Draft PR → exact-head CI/review → Ready → STOP → explicit owner squash merge → verify exact main → separate production decision`

Permanent rules:

1. `turpini` authorizes source-only work to Ready, not merge or deploy.
2. Merge requires an explicit owner command such as `squash merge #...`.
3. Every merge must be followed by an explicit `Production deploy: YES/NO` classification.
4. Production deploy, Cloudflare mutation, D1 write/migration, secret mutation, GitHub App permission changes, Access/routing mutation, webhook activation, Queue/DLQ activation and host/root mutation require separate explicit authorization.
5. Merge authorization is never production authorization.
6. Exact SHA, exact CI run and fresh remote state are required before privileged actions.
7. Parallel work can move `main`; chat memory is not authoritative.
8. Source target is not production state.
9. Once a gate emits `DEPLOY_STARTED=YES`, the authorization is consumed even if a later verification step fails.
10. After `DEPLOY_STARTED=YES`, blind retry is forbidden. Reconciliation must be read-only first.
11. Secrets, JWTs, installation tokens, Access tokens, Cloudflare API tokens, private PEM contents and raw upstream error bodies must never be committed to GitHub.

Shell instructions supplied to the owner also intentionally avoid `set -Eeuo pipefail`; safe blocks use a subshell plus explicit return-code checks so an audit/preflight failure does not terminate the interactive terminal session.

## 3. GitHub App and production trust boundary

The GitHub App used by Rozkalns Control is intentionally read-only.

Known configuration captured during this work:

- App name: `Rozkalns Control`;
- App id: `4567356`;
- client id: `Iv23likDoFtVeWBJfdFS`;
- installation id: `153121564`;
- installed on exactly six repositories:
  - `rozkalnsandris/hermes-tech`;
  - `rozkalnsandris/hermes-deals`;
  - `rozkalnsandris/rozkalns-cv`;
  - `rozkalnsandris/RPi5_main`;
  - `rozkalnsandris/ops-workflows`;
  - `rozkalnsandris/rozkalnsandris`;
- `rozkalnsandris/hermes-email-skill` is excluded;
- permissions remain read-only for the required Metadata, Contents, Issues, Pull requests, Checks and Actions surfaces;
- GitHub mutation is disabled in the Control Panel runtime;
- webhook runtime is disabled;
- Phase 3 write paths are not activated.

The production private key is represented only as the Worker secret binding `GITHUB_APP_PRIVATE_KEY_PEM`. Its plaintext must not appear in source, CI logs, audit docs or issues.

## 4. Diagnostic campaign timeline

### 4.1 Live dashboard source was prepared

PR #102 introduced the normalized read-only dashboard snapshot and the single `/api/github/dashboard` endpoint. The UI performs one dashboard fetch and GitHub mutations remain disabled.

The design intentionally fails closed: incomplete branch-policy evidence is never represented as `MERGE_READY`.

Subsequent source work hardened API routing and production verification so `/api/*` reaches the Worker, Access is preserved, and stable health checks are used before writes.

### 4.2 First production live-read activation exposed a generic failure

The first live-read activation was authorized against exact source/CI and crossed the production write boundary.

Observed post-write state included:

- active version: `50493d7f-8e4a-44a8-92c4-a176ed4e89dc`;
- active deployment: `936bc5d5-2ff2-4d32-97b0-7ef498cb8967`;
- traffic: `100%`;
- `/api/github/dashboard`: HTTP 502 / `LIVE_DASHBOARD_FAILED`;
- reconciliation: HTTP 502 / generic `LIVE_READ_FAILED`.

The important result was operational, not functional: the Worker deploy itself succeeded, production routing remained intact, and the failure was downstream of the write. The authorization was consumed and was not replayed.

### 4.3 PR #117 — sanitized live-read runtime diagnostics

Issue #116 / PR #117 added bounded public failure projection.

Historical exact head:

`2ad0f3c3e13f2c2f253ab0af54be6fdb3bb077dc`

Merged main:

`84e29b3fa2d1a58145741dadd3e8a4ebf39b635d`

Exact-main CI:

- CI #220;
- run `31840926604`;
- success.

The route gained sanitized categories including credential, authorization, rate-limit, not-found, transport, malformed-response, GraphQL and invalid-request outcomes without exposing raw upstream data.

### 4.4 PR #119 — fail-closed maintenance redeploy gate

Issue #118 / PR #119 introduced the existing-domain one-shot live-read maintenance redeploy gate.

Historical exact head:

`aa43bff958641dd29c36595bb85e52bb74a8cfb1`

Merged main:

`516d8f1f00198f30568cd624eeb606e3df92e063`

Exact-main CI:

- CI #222;
- run `31841454845`;
- success.

The gate binds an owner authorization to exact:

- source SHA;
- successful CI run;
- current Worker version;
- current deployment;
- Custom Domain id.

It checks source config, production bindings, workers.dev/preview state, Access health and routing before write, performs one strict Wrangler deploy, then verifies postdeploy state. It emits the permanent write-boundary markers:

- `DEPLOY_STARTED=YES`;
- `AUTHORIZATION_CONSUMED=YES`;
- `NO_BLIND_RETRY_IF_STOP_AFTER_DEPLOY_STARTED=YES`.

### 4.5 A stale diagnostic canary invalidated the first maintenance diagnostic

The initial maintenance diagnostic used a hard-coded Hermes Deals target. The hard-coded PR later became merged/closed while the gate still expected an open PR snapshot.

The source reconciliation contract requires an open PR. Therefore a closed hard-coded PR could not be a valid diagnostic target.

This was a real diagnostic-design defect, not evidence that the GitHub App secret, permissions or Worker network path were broken.

One observed redeploy produced active version:

`0b803c37-afc9-48d5-8b33-cf1134a0fc47`

A later read-only preflight proved its active deployment as:

`55348af8-694d-46c8-afa3-f527755f71b4`

The gate did not complete its diagnostic cleanly and the authorization had already been consumed. No blind retry or rollback was performed.

### 4.6 PR #121 — provider/parser failures stopped falling through to generic live-read failure

Issue #120 / PR #121 fixed a source projection gap.

Historical exact head:

`1348edf9d45e91bf27d55a4358c6510d2cfa11ff`

Merged main:

`1bde0f0cb8e77cc5c5d0e8277cb379ee8eecd58`

Exact-main CI:

- CI #224;
- run `31842744143`;
- success.

The route now maps provider/parser `MALFORMED_RESPONSE` to `GITHUB_RESPONSE_INVALID` and provider/parser `INVALID_REQUEST` to `GITHUB_READ_INVALID` instead of collapsing them into generic `LIVE_READ_FAILED`.

### 4.7 PR #123 — diagnostic canary freshness became part of the authorization contract

Issue #122 / PR #123 removed the hard-coded canary identity and bound the diagnostic target to exact owner-reviewed values.

Historical exact head:

`9cd4da759b412d169e86a17452c835626e942472`

Merged main:

`e7c01f2d8129df0c5f5d0e8277cb379ee8eecd58`

Exact-main CI:

- CI #226;
- run `31843623492`;
- success.

The gate now accepts and validates:

- `--diagnostic-issue`;
- `--diagnostic-pull`;
- `--diagnostic-head-sha`.

It proves the diagnostic issue is still an open issue, the diagnostic PR is still open, the PR head SHA matches exactly, and both PR base/head repositories are the expected repository.

Freshness is checked three times:

1. PREWRITE;
2. FINAL_PREWRITE;
3. POST_VERIFY_TARGET.

The canary selected after stale-target discovery was:

- repository: `rozkalnsandris/hermes-deals`;
- issue: #631;
- PR: #650;
- exact head: `29681f0388f6289dde758f7bd6a4256b271a64e2`.

### 4.8 Production diagnostic after #121/#123 returned `GITHUB_CREDENTIAL_UNAVAILABLE`

A fresh owner-authorized redeploy was executed after the above source hardening.

Observed result:

- new version: `aa39b6f9-4187-478e-9029-88e0d23048e8`;
- active deployment: `aaff54a4-e429-4641-be65-c42a00662c75`;
- traffic: `100%`;
- diagnostic target remained #631/#650 at exact head `29681f...`;
- Access protection preserved;
- live-read binding remained true;
- workers.dev disabled;
- preview URLs disabled;
- `SANITIZED_DIAGNOSTIC_RESULT=GITHUB_CREDENTIAL_UNAVAILABLE`.

This authorization was consumed.

The result narrowed the problem, but it still did not prove that the private key was wrong. At that point the runtime collapsed multiple session-acquisition failure modes into the same public credential-unavailable category.

### 4.9 PR #125 — credential-stage outcomes were preserved

Issue #124 / PR #125 added bounded credential-stage classification without changing GitHub App authentication behavior.

Historical exact head:

`3cf08c42b7867d01d2c2aa21514362be49719c3e`

Merged main:

`e9f912f3ad8a0803b26d97cf6d38c593efe4496c`

Exact-head CI before merge:

- CI #227;
- run `31844774050`;
- success.

Exact-main CI after merge:

- CI #228;
- run `31845684657`;
- success.

The change deliberately did not modify JWT claims/signing, installation-token request body, GitHub App permissions, secret binding or routing. It preserved bounded token-exchange outcomes so the next canary could distinguish credential signing/config from installation-token HTTP outcomes.

### 4.10 Production diagnostic after #125 returned `GITHUB_TRANSPORT_FAILED`

The next owner-authorized redeploy completed successfully.

Observed output:

- `DEPLOY_STARTED=YES`;
- `AUTHORIZATION_CONSUMED=YES`;
- new version: `0155bfca-c460-4c8e-ae23-679db3611b22`;
- active deployment: `5fc8db80-0227-42d8-a48f-890fcf83eb98`;
- traffic: `100%`;
- domain unchanged;
- Access protection preserved;
- live-read binding true;
- GitHub mutation disabled;
- webhook runtime disabled;
- workers.dev disabled;
- preview URLs disabled;
- `SANITIZED_DIAGNOSTIC_RESULT=GITHUB_TRANSPORT_FAILED`.

This authorization is permanently consumed.

This was meaningful progress: the production runtime no longer stopped at the earlier generic credential-unavailable classification. However, the public transport code still represented three possible HTTP stages:

1. installation-token exchange;
2. authenticated REST read;
3. authenticated GraphQL read.

The root cause therefore remained unresolved.

### 4.11 PR #127 — transport failure now carries a bounded stage

Issue #126 / PR #127 added a bounded `stage` field while keeping the existing public error code `GITHUB_TRANSPORT_FAILED`.

Historical exact head:

`b97de21e5a88ca0bf8f70ff950d99c448eb13c69`

Merged main:

`3f5317996d870f3814970ad99d255dd0bd5120c9`

Exact-head CI before merge:

- CI #229;
- run `31846540479`;
- success.

Exact-main CI after merge:

- CI #230;
- run `31846676406`;
- success.

The only allowed transport stages are:

- `token-exchange`;
- `rest`;
- `graphql`.

The route returns only the bounded stage with `Cache-Control: no-store`. Tests explicitly reject leakage of private-key text, JWT-like text, `api.github.com` URLs and arbitrary upstream body content.

The deploy gate allowlist did not need to expand because the public error code remains `GITHUB_TRANSPORT_FAILED`.

### 4.12 Latest read-only production preflight after #127 merge

The owner ran a fresh read-only preflight after #127 reached `main`.

Observed source and production state:

- exact main: `3f5317996d870f3814970ad99d255dd0bd5120c9`;
- exact-main CI run: `31846676406`;
- current production version: `0155bfca-c460-4c8e-ae23-679db3611b22`;
- current production deployment: `5fc8db80-0227-42d8-a48f-890fcf83eb98`;
- active traffic: `100%`;
- domain id: `ac685929d45e825df5b5f6b803a9814b6dbf5d9d`;
- diagnostic target fresh: yes;
- current reconcile result: `GITHUB_TRANSPORT_FAILED`;
- current reconcile stage: `NOT_AVAILABLE_ON_CURRENT_VERSION`;
- required secret binding present;
- Access health canary pass;
- workers.dev disabled;
- preview URLs disabled;
- production write: no;
- authorization consumed: no.

That proves #127 still needs to reach production before the new bounded stage can be observed.

## 5. Authorization ledger

The deployment campaign has repeatedly enforced the distinction between source state, authorization and write completion.

### 5.1 Consumed authorizations

Any authorization whose execution output included `DEPLOY_STARTED=YES` is consumed permanently.

Known consumed diagnostic deployments in this audit include the deployments that produced:

- version `50493d7f-8e4a-44a8-92c4-a176ed4e89dc`;
- version `0b803c37-afc9-48d5-8b33-cf1134a0fc47`;
- version `aa39b6f9-4187-478e-9029-88e0d23048e8`;
- version `0155bfca-c460-4c8e-ae23-679db3611b22`.

None of those exact authorizations may be replayed.

### 5.2 Current pending authorization

The newest authorization is bound to the exact tuple listed in section 1.3.

At the audit cutoff there is no pasted execution result proving `DEPLOY_STARTED=YES` for that newest tuple.

Therefore:

- production deploy status for the newest authorization: `NOT_PROVEN_EXECUTED`;
- authorization state: `AUTHORIZED_PENDING_EXECUTION`;
- authorization consumed: `NO` at audit cutoff.

If a later log shows `DEPLOY_STARTED=YES`, the durable record must be updated immediately to `CONSUMED`, regardless of whether later verification succeeds.

## 6. Findings

### Finding A — stale diagnostic identity can create a false root-cause narrative

The hard-coded PR canary became closed/merged. Because the runtime requires an open PR snapshot, that target could never satisfy the intended reconciliation contract.

Impact:

- diagnostic output could be misread as a GitHub App/runtime failure;
- repeated production changes would not fix the stale target;
- secret or permission mutation would have been unjustified.

Resolution:

PR #123 made exact issue/PR/head freshness part of the owner authorization and validates it before and after the write.

### Finding B — generic error projection hid actionable distinctions

Provider/parser errors and later credential/session errors were initially collapsed too aggressively.

Impact:

- `LIVE_READ_FAILED` and later `GITHUB_CREDENTIAL_UNAVAILABLE` were insufficient to determine the next safe action.

Resolution:

PRs #117, #121 and #125 progressively introduced bounded, sanitized classification without exposing upstream details.

### Finding C — current unresolved class is transport, not yet a proven secret defect

The newest directly proven production result is `GITHUB_TRANSPORT_FAILED`.

That result is not sufficient to conclude that:

- the GitHub App private key is invalid;
- the secret must be rotated;
- GitHub App permissions must be expanded;
- the installation id is wrong;
- Cloudflare routing must change;
- rollback is required.

PR #127 exists specifically to identify the failing HTTP stage before any such mutation is considered.

### Finding D — local build secret warnings are not production binding evidence

Local/CI builds can emit a warning such as:

`Missing required secrets: GITHUB_APP_PRIVATE_KEY_PEM`

when the local process does not contain the production secret.

That warning must not be interpreted as proof that production is missing the secret.

The production gate and read-only preflights separately proved that the required secret binding exists on the active Worker version. The secret value itself was never printed.

### Finding E — production remained structurally healthy through each diagnostic redeploy

Across the owner-provided successful redeploy outputs, the following remained intact:

- `100%` traffic to the active version;
- the existing Custom Domain;
- Access protection;
- D1 binding;
- GitHub App client/install ids;
- live-read enablement;
- workers.dev disabled;
- preview URLs disabled;
- GitHub mutation disabled;
- webhook runtime disabled.

The unresolved failure is therefore inside the live GitHub read path, not evidence of a general Worker/domain/Access outage.

### Finding F — repeated diagnostic deploys are acceptable only when each adds new bounded information

This campaign used multiple production redeploys, but each later deploy was justified only after source changed the diagnostic information boundary:

- generic failure → sanitized categories;
- stale canary → exact fresh canary;
- generic credential failure → credential-stage categories;
- generic transport failure → bounded transport stage.

A redeploy that does not add new information or a functional fix would not be justified.

## 7. Current unresolved question

The remaining question is exactly:

> At which bounded stage does the production GitHub read path fail after PR #127 is deployed?

Allowed answers:

1. `token-exchange`;
2. `rest`;
3. `graphql`;
4. reconciliation succeeds and no transport stage applies;
5. the result changes to another already-bounded public diagnostic code.

No broader speculation is needed before this answer exists.

## 8. Next safe decision tree

### 8.1 If the pending #127 redeploy is not executed

Do nothing to production. The source is ready, exact-main CI is green, and the last proven production remains version `0155bfca-...` with `GITHUB_TRANSPORT_FAILED` and no stage.

### 8.2 If the pending #127 redeploy is executed

The gate must fresh-check, before the write:

- exact `main`;
- exact successful CI run;
- exact current version/deployment;
- exact domain id;
- live bindings;
- workers.dev/preview state;
- Access health;
- issue #631 open state;
- PR #650 open state;
- exact PR head `29681f...`;
- exact base/head repository identity.

Only after those checks may it emit `DEPLOY_STARTED=YES` and perform one strict deploy.

After `DEPLOY_STARTED=YES`:

- the authorization is consumed;
- do not rerun the same block;
- if postverify is ambiguous, perform read-only reconciliation only.

### 8.3 If stage = `token-exchange`

Investigate the Worker request that exchanges the GitHub App JWT for an installation token.

Do not rotate the key merely because this stage is selected. First determine whether the failure is a Worker fetch exception/timeout or another transport-level condition. Existing typed HTTP outcomes such as 401/403/404/422 are already classified separately and should not be confused with a transport exception.

### 8.4 If stage = `rest`

The installation-token session has progressed far enough for an authenticated REST read to be attempted. Investigate the REST request construction, outbound fetch exception/timeout behavior and request-specific runtime path.

Do not change GitHub App permissions unless a bounded authorization/forbidden result actually proves a permission problem.

### 8.5 If stage = `graphql`

The session and earlier REST path have progressed far enough for the GraphQL merge-state read to be attempted. Investigate the GraphQL transport path specifically.

### 8.6 If reconciliation = `RECONCILIATION_OK`

The live GitHub reconciliation path works. The next action should be read-only validation of `/api/github/dashboard` against the expected normalized dashboard contract before considering Phase 2 live-read activation complete.

### 8.7 If another bounded code appears

Follow the existing bounded classification rather than broadening permissions or mutating secrets by default.

Examples include:

- `GITHUB_UNAUTHORIZED`;
- `GITHUB_FORBIDDEN`;
- `GITHUB_RESOURCE_NOT_FOUND`;
- `GITHUB_RESPONSE_INVALID`;
- `GITHUB_GRAPHQL_FAILED`;
- `GITHUB_UNEXPECTED_STATUS`;
- `GITHUB_READ_INVALID`.

## 9. Changes explicitly not justified by current evidence

At the audit cutoff, the evidence does **not** justify any of the following:

- GitHub App private-key rotation;
- GitHub App permission expansion;
- changing the six-repository installation selection;
- enabling GitHub writes;
- enabling webhook runtime;
- enabling Queue/DLQ;
- enabling workers.dev;
- enabling preview URLs;
- bypassing Cloudflare Access;
- changing the Custom Domain;
- D1 write or migration;
- rollback of the current healthy Worker version solely because the read path returns a bounded diagnostic error;
- blind replay of a consumed deployment authorization.

## 10. Source/production split at audit cutoff

### Source

- `main`: `3f5317996d870f3814970ad99d255dd0bd5120c9`;
- exact-main CI #230 / `31846676406`: success;
- #127 transport-stage diagnostics are merged;
- source can expose `stage: token-exchange | rest | graphql`.

### Production

Last directly proven:

- version: `0155bfca-c460-4c8e-ae23-679db3611b22`;
- deployment: `5fc8db80-0227-42d8-a48f-890fcf83eb98`;
- result: `GITHUB_TRANSPORT_FAILED`;
- stage: unavailable because #127 is not yet proven deployed.

### Authorization

- a fresh one-shot #127 diagnostic redeploy authorization exists;
- it is bound to the exact tuple in section 1.3;
- no execution output is present in the audit source conversation;
- therefore it is pending and unconsumed at the cutoff.

This three-way split is the authoritative continuation point.

## 11. Related source evidence

Primary diagnostic issue/PR chain:

- #116 / #117 — sanitized live-read failure diagnostics;
- #118 / #119 — fail-closed live-read maintenance redeploy gate;
- #120 / #121 — provider/parser diagnostic projection;
- #122 / #123 — exact fresh diagnostic canary binding;
- #124 / #125 — credential-stage diagnostic preservation;
- #126 / #127 — bounded transport-stage projection;
- #128 — this audit.

Important earlier Phase 2 source chain referenced by the conversation:

- #101 / #102 — normalized live read-only dashboard;
- #103 / #104 — source live-read enablement boundary;
- #105 / #106 — Worker-first `/api/*` routing;
- #108 / #109 — Access-authenticated production canary;
- #110 / #111 — stable health prewrite / new-feature postdeploy canary separation.

Historical/reusable lessons are also recorded in `docs/LESSONS_2026-08-14.md`.

## 12. Audit conclusion

The campaign has not yet proven the final live-read dashboard path healthy, but it has substantially reduced uncertainty without weakening the production trust boundary.

The strongest current statement is:

- Cloudflare Worker deployment, traffic, domain, Access and required bindings are healthy in the last proven production state;
- the GitHub live-read path returns a bounded transport failure;
- source now contains the minimum safe diagnostic needed to locate that failure at `token-exchange`, `rest` or `graphql`;
- no credential, permission or rollback mutation is currently justified;
- the newest deployment authorization exists but is not proven executed or consumed at this audit cutoff.

The next authoritative evidence must come from the one-shot #127 production redeploy if the owner executes it, followed immediately by read-only reconciliation of the bounded transport stage.
