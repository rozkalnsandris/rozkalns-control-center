# Phase 5 RPi5 observation — Worker activation executor

This document describes the concrete **source-only** executor prepared by issue #615 for the future `WORKER_ACTIVATE` mutation class. It does not grant LIVE authority and it does not execute the workflow.

Canonical implementation:

- workflow: `.github/workflows/phase5-rpi5-observation-worker-activate-live.yml`
- executor: `scripts/phase5-rpi5-observation-worker-activate-live.mjs`
- machine contract: `.github/phase5-rpi5-observation-worker-activation-executor-contract.json`
- candidate validator: `src/shared/phase5-worker-activation-candidate.ts`
- GitHub Environment declaration: `production-worker-activation-live`

## Source/LIVE boundary

Merging this source does not authorize production. A future LIVE run still requires a separate explicit owner command bound to exact current `main`, exact successful push CI, a fresh successful first-attempt Phase 5 read-only preflight, exact active Worker deployment/version, exact reviewed candidate SHA-256 and public verification-key `key_id`.

The command shape is public-safe and contains no secret or private-key value:

`AUTHORIZE LIVE PHASE5 WORKER ACTIVATE rozkalns-control-center source_sha=<sha> ci_run=<ci_run_id> preflight_run=<run_id> deployment=<deployment_id> version=<version_id> candidate_sha256=<candidate_manifest_sha256> key_id=<public_key_id> ingest=true`

## Prewrite fail-closed gates

Before authorization can be consumed, the executor requires all of the following:

- exact default-branch first-attempt `workflow_dispatch` on the authorized source SHA;
- exact successful push CI on that SHA;
- exact successful first-attempt `.github/workflows/phase5-rpi5-observation-readonly-preflight.yml` run on that SHA;
- exact successful first-attempt verification-key provisioning workflow identity from the reviewed candidate;
- candidate manifest bytes whose SHA-256 exactly equals the owner-authorized `candidate_sha256`;
- exact `wrangler.jsonc` SHA-256 bound by the candidate, canonical Node `24.19.0` and Wrangler `4.120.0`;
- built static assets before the first Worker mutation can begin;
- active Worker baseline equal to the owner-authorized deployment/version at 100% traffic;
- dormant ingest baseline (`ABSENT` or plain-text `false`), protected `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS:secret_text` with no readable value, unchanged `CONTROL_DB`, and exact non-target binding digest;
- D1 resource identity `rozkalns-control-production` / `8504e986-faf0-450c-bfb5-41b5dbf8be09` / `eu`;
- GET/SELECT-only proof that migrations `0010` through `0013` and the reviewed Phase 5 schema/index are present-valid.

The workflow exposes only public-safe dispatch inputs. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_D1_READ_TOKEN` are read-only evidence credentials. `CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN` is a dedicated protected Workers Scripts write token and is scoped only into the Wrangler mutation child processes.

## Exact mutation ceiling

The executor materializes an ephemeral config from exact `wrangler.jsonc` and proves that its sole config delta is:

`CONTROL_RPI5_OBSERVATION_INGEST_ENABLED = "true"`

All other config remains equal. The only permitted production mutation sequence is:

1. emit `WORKER_VERSION_UPLOAD_STARTED=YES` and `AUTHORIZATION_CONSUMED=YES`;
2. execute exactly one `wrangler versions upload` using the exact candidate config, with automatic resource provisioning disabled;
3. GET the exact returned version and prove ingest is plain-text `true`, the verification-key binding remains protected, `CONTROL_DB` is unchanged, and the non-target binding digest is unchanged;
4. repeat exact-main/GitHub evidence, D1 present-valid evidence and the active baseline drift guard;
5. only then emit `EXACT_VERIFIED_VERSION_DEPLOY_STARTED=YES` and execute exactly one `wrangler versions deploy <verified-version>@100%`;
6. perform GET/SELECT-only postdeploy reconciliation.

Ordinary `wrangler deploy` is forbidden because it combines version creation and activation and removes the required GET verification barrier. `wrangler triggers deploy` is also absent/forbidden. Cloudflare documents `wrangler versions upload` as creating a version without immediate deployment and documents trigger application (routes, domains and cron) as a separate `wrangler triggers deploy` command.

There is no D1 write, secret write, Queue mutation, route/custom-domain/cron mutation, Cloudflare account/Access/DNS/Tunnel mutation or RPi5 mutation path in this executor. Queue producer bindings that are part of the Worker version remain covered by the exact non-target binding digest and the candidate's full-config equality guard; Queue consumer/trigger mutation is not invoked.

## After the first upload starts

The first Worker version upload consumes the one-shot owner authorization. From that point onward, any command error, API error, timeout, source/main drift, D1 drift, active baseline drift, candidate mismatch, missing/ambiguous uploaded version, or other unexpected state is:

`POST_MUTATION_STATE=REVIEW_REQUIRED`

and STOP.

There is no automatic retry, rollback, cleanup, version deletion, alternate candidate, alternate version selection or cross-class mutation. If upload succeeds but GET verification fails, the executor stops and **does not deploy** that version.

## Sanitized Wrangler failure diagnostics

For each Wrangler mutation child, the executor sets `WRANGLER_OUTPUT_FILE_PATH` to its exact NDJSON output file. If Wrangler returns a non-zero status, the executor does **not** print the captured Wrangler stdout/stderr or any raw NDJSON field. It reads only that configured structured-output file, caps the read to 64 KiB / 64 parsed records, derives a public-safe class, and then retains the existing `STOP=WRANGLER_WRITE_FAILED` fail-closed path.

The bounded diagnostic receipt is limited to fixed markers:

- `WRANGLER_FAILURE_DIAGNOSTIC=AVAILABLE|UNAVAILABLE`
- `WRANGLER_FAILURE_REASON=<bounded reason>`
- `WRANGLER_FAILURE_CLASS=AUTH|PERMISSION|CONFIG|STRICT_CONFLICT|UNKNOWN`
- `WRANGLER_FAILURE_DETAIL=<sanitized fixed detail>`
- `WRANGLER_FAILURE_RAW_FIELDS_EMITTED=NO`

Classification may inspect Wrangler's structured `type` / `code` / `name` / `message`-style signals, but their raw contents are never emitted. Token, secret, authorization, credential, private/config/value/body/header/request/response-like fields are not copied into the receipt. Missing, unreadable, oversized or wholly malformed structured output produces an `UNAVAILABLE` diagnostic rather than falling back to stdout/stderr. A partially malformed file may still classify parseable records while recording that malformed lines were suppressed.

These markers are evidence only. They do not retry the failed write, alter the one-shot authorization-consumption boundary, select a version, roll back anything, or authorize another mutation.

## Successful public-safe receipt

A successful later LIVE run may emit public-safe markers including:

- `CANDIDATE_MANIFEST=VALID`
- `D1_PHASE5_GATE=PRESENT_VALID_0010_THROUGH_0013`
- `SOURCE_CONFIG_DELTA=INGEST_ONLY`
- `TRIGGER_ROUTE_CUSTOM_DOMAIN_QUEUE_MUTATION_PATH=ABSENT`
- `WORKER_VERSION_UPLOAD_STARTED=YES`
- `UPLOADED_CANDIDATE_GET_VERIFY=PASS`
- `PREDEPLOY_DRIFT_GUARD=PASS`
- `EXACT_VERIFIED_VERSION_DEPLOY_STARTED=YES`
- `ACTIVE_TRAFFIC_PERCENT=100`
- `INGEST_BINDING=PLAIN_TEXT_TRUE`
- `VERIFICATION_KEY_BINDING=PRESENT_PROTECTED_UNCHANGED`
- `SECRET_VALUE_OBSERVED=NO`
- `CONTROL_DB_BINDING=UNCHANGED`
- `NON_TARGET_BINDING_INVENTORY=UNCHANGED`
- `D1_MUTATION=NO`
- `SECRET_MUTATION=NO`
- `RPI5_MUTATION=NO`
- `NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES`
- `PHASE5_WORKER_ACTIVATE=PASS`

These markers are evidence only. They do not authorize the next mutation class or the RPi5 trust boundary.
