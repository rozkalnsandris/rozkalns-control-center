# Owner Action Panel activation preparation

This is the preparation contract for the seven-action panel merged in PR #684.
It does not authorize production changes. Retry CI remains unavailable under
its separate Actions-write/executor gate. Existing Merge/Needs changes/Later
security and the panel vocabulary are unchanged.

## Why a new preflight is necessary

The Daily MVP preflight freezes a historical Worker version/deployment.
The Phase 5 dormant preflight rejects an already-active observation binding and
only examines migrations 0010-0013. The retired production-d1 workflow cannot run.
None proves the continuation 0007/0014 schema, continuation bindings or campaign
association needed by the new panel. Do not replay historical activation jobs.

Run owner-panel-readonly-preflight.yml manually from freshly verified main after
its source merge and exact-main CI. Its fixed-target script uses GET plus three
allowlisted SELECT statements through D1's query API. There is no arbitrary SQL,
workflow target, URL, rollout command, mutation probe or retry. Redirects are
rejected; provider errors and protected configuration never enter the receipt.

The existing production-readonly-reconcile environment supplies:
- CLOUDFLARE_API_TOKEN for Worker metadata GETs;
- CLOUDFLARE_D1_READ_TOKEN for fixed D1 resource/schema/aggregate SELECTs;
- optional CONTROL_ACCESS_CLIENT_ID / CONTROL_ACCESS_CLIENT_SECRET for GET
  /api/health and the UI shell. Missing Access credentials are NOT_PROVEN, not PASS.
No secret is created, rotated, exported or printed.

Receipt evidence includes exact source/main CI, a single active version at 100%,
deployment/version identities, a non-target binding digest, exact schema comparison
against source migrations, migration 0014 SHA-256, aggregate existing-campaign/PR
association counts, health/version identity and UI-shell digest where accessible.
The shell digest is not proof that React rendered seven actions. Binding metadata
does not prove the GitHub private key works or the Access owner policy is correct.
The receipt therefore never emits activation_ready=true.

## Exact targets and prerequisites

Account: 70e29dbca0e8363358659102d2b74178.
Worker: rozkalns-control. Origin: https://control.rozkalns.net.
D1: rozkalns-control-production, 8504e986-faf0-450c-bfb5-41b5dbf8be09, jurisdiction eu.
CONTROL_DB must bind that exact D1 ID.

The activation candidate must contain these three plain-text bindings:
- CONTROL_CONTINUATION_RUNTIME_ENABLED = exactly true;
- CONTROL_CONTINUATION_ACCESS_ISSUER = https://super-salad-2357.cloudflareaccess.com;
- CONTROL_CONTINUATION_ACCESS_AUDIENCE = the observed audience of the separately
  approved dedicated human-only continuation Access application.

Verify the issuer against current Access evidence. The historical action-app
audience is not the continuation audience: its observed policy is service-only
and its destinations do not cover continuation. Never reuse the wildcard app
audience or fabricate a new audience. Inventory reports PRESENT_UNVERIFIED for
an audience binding; presence alone cannot prove its policy or destination scope.

Issue #689 defines the separate Access prerequisite: at most one new self-hosted
application, named Rozkalns Control owner continuation, and one Allow policy
including only the privately supplied exact owner email. Destinations are exactly
control.rozkalns.net/api/control/continuation and
control.rozkalns.net/api/control/continuation/preflight. Path protection includes
descendants; Worker routes remain exact. No Everyone, domain-wide, Family group,
IP bypass or Service Auth selector. Verify the exact existing login provider;
do not infer an identity mapping or create an IdP. Keep raw identity selectors
and authentication material out of public source/evidence. Proposed session is
1h with HttpOnly and SameSite=Lax, subject to actual browser verification.

Before any separately authorized Access write, freeze target absence, exact
owner/IdP/payload and non-target configuration digests. Existing target or drift
means STOP. Attach only the owner policy at application creation; an unattached
policy may be prepared first, but never create an unprotected application.
The returned application ID/audience and unchanged non-target configuration must
be verified with GET before a later Worker activation envelope can be frozen.
No existing app/policy, IdP, secret or permission may change under that envelope.

Continuation alone opts into cryptographic human-only JWT verification: service
claims and missing human identity are rejected before domain/store access.
Other authenticator consumers retain their existing behavior. The Worker guard
does not substitute for the exact owner selector in the dedicated Access policy.

The client keeps mutations disabled on Access redirects/401/403 and explains
that owner sign-in is required. Local browser tests simulate sign-in/expiry and
return to the exact card with a new explicit confirmation; they do not prove
Cloudflare login or provision an application. Before activation, verify real
top-level login for the dedicated application, return to the exact decision,
fresh GET eligibility, and no automatic POST. A root-app cookie, machine CI,
disabled-runtime 503 or method 405 alone does not prove human authentication.
No token extraction or service-token substitution is allowed. Health 403 remains
a separate read-only diagnosis; this application does not repair it.

Reuse GITHUB_APP_CLIENT_ID Iv23likDoFtVeWBJfdFS,
GITHUB_APP_INSTALLATION_ID 153121564 and the protected
GITHUB_APP_PRIVATE_KEY_PEM binding. Presence is not credential usability.
An authenticated existing GitHub read/preflight must prove the selected managed
repository can be read with the existing scoped installation session.
Do not mint/export tokens in the inventory or expand permissions.

Migration 0007 must already be recorded with matching continuation_campaigns and
continuation_tasks schemas. Existing campaign records must identify an exact
current task with an active PR for the card preflight's unique join. A missing
campaign is a product prerequisite, not permission to insert a fixture or seed
a production campaign. An incomplete task/human gate legitimately blocks Continue.

Migration 0014 is CREATE TABLE continuation_action_audit only, with the exact
source constraints. If its history record AND exact table exist, do not reapply.
If both are absent and all predecessor migration/schema evidence is coherent,
the separate D1 gate may apply only 0014 and record that migration once.
Partial/mismatched evidence must STOP; never repair/drop/recreate automatically.
Do not run an unrestricted migrations apply over unknown pending migrations.
Do not reuse the Phase 5 executor, whose whitelist is 0011-0013.

## Later bounded LIVE plan — not authorization

Freeze a fresh final deployable source SHA, exact-main CI, active deployment,
active version, non-target binding digest, migration checksum and D1 pre-state
before requesting execution. Unknown values are not valid authorization fields.

1. D1 prerequisite gate, only if 0014 is absent consistently: one exact migration
   apply and its single migration-ledger entry; zero campaign/task/decision data
   writes. Re-read ledger and exact schema afterwards. No other migration.
2. Candidate configuration/build: preserve every non-target binding and existing
   secret reference, including already-active Phase 5 configuration absent from
   an older checked-in Wrangler file. Permit only the three continuation vars
   above to differ. Do not copy protected values into source or a public artifact.
   A plain generic deploy of the current Wrangler config is not sufficient proof
   that externally activated bindings will survive.
3. Worker/UI rollout gate: one candidate version upload, at most two deployment
   writes (old@100% + candidate@0%, then candidate@100%), no automatic rollback,
   retry or cleanup. Source SHA and baseline drift stop the sequence.
4. Before promotion, GET candidate health with exact version override, verify
   candidate settings and non-target digest, fetch exact candidate UI assets,
   and use authenticated continuation GET preflight for an existing exact card.
   Verify full actionStates vocabulary and fail-closed unauthorized behavior.
   Do not send Continue, Pause, Merge, Later, Needs changes or Retry CI mutations.
5. After promotion, repeat GET/version/UI/schema checks. Record actual mutation
   counts and observed version/deployment. A later explicit owner button press
   remains a separate authenticated action.

The existing production-worker-composite-live.yml defines the UPLOAD1/DEPLOY2
shape, but its health-only candidate smoke and checked-in configuration are not
by themselves the full continuation activation gate. The final bounded operator
must preserve/compare non-target bindings and verify the panel/continuation
read paths before promotion; choose/finalize it after the fresh inventory.
Do not present its generic authorization string as authorization for D1,
Access, binding expansion or continuation action canaries.

## Readiness and stop rules

Source CI/PR approval is not a production inventory receipt. Inventory success
is not owner policy/credential/campaign eligibility and is not LIVE authority.
Stop at the source merge gate if this manual workflow has not reached main.
After merge, run only the inventory, then finalize the exact later D1 and Worker
envelopes from its evidence. If no workflow-dispatch capability is available in
the session, report that executor limitation; never rerun an unrelated old job
as a substitute or request fresh production permissions merely to obtain reads.

No deployment, D1 apply, Cloudflare/Access/binding/secret change, GitHub App
permission change, production decision POST, notification send or RPi5 operation
is performed by this preparation. The RPi5 #532 lane is excluded.

Official platform references checked during preparation:
- https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
- https://developers.cloudflare.com/workers/versions-and-deployments/
- https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/

## Safe failure diagnostics

A failed inventory exits 1 and emits a STOP receipt with an allowlisted stage,
a local contract/error-category code and a numeric HTTP status when available.
It never prints exception text, URLs, headers, provider error bodies, credentials
or partial inventory. Unknown errors remain sanitized and fail closed.
No failure causes a retry or any subsequent inventory request.

Stages distinguish environment validation, GitHub main/CI, Worker deployment and
version/bindings, D1 identity/history/schema/campaign counts, health/UI and the
final main/deployment drift guards. Contract validation failures retain their
locally defined codes, including D1_ZERO_WRITES_NOT_PROVEN. Missing D1 write
metadata is still a stop, even though the provider API describes it as optional.

HTTP_ERROR with 403 alone does not prove a missing permission: GitHub also uses
403 for rate limiting. HTTP status 3xx means the redirect was rejected; do not
follow it with credentials. NETWORK_ERROR, NETWORK_TIMEOUT and
RESPONSE_DECODE_ERROR distinguish transport/decoding failures without exporting
their messages. RESPONSE_SHAPE_INVALID identifies unusable response structure.
The stage identifies the failed phase, not a proven provider root cause.

After a failed run, preserve its exact source SHA/run ID and sanitized receipt.
Review the identified contract against official documentation before proposing
a scoped correction. Do not weaken checks or expand permissions to force PASS.
Follow the repository recovery gate; this diagnostic receipt is not retry,
merge or LIVE authorization. A new main run is needed after a reviewed source
fix is merged; rerunning an old SHA does not test the fix.

Diagnostic references checked:
- https://docs.python.org/3/library/urllib.error.html
- https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api
- https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
