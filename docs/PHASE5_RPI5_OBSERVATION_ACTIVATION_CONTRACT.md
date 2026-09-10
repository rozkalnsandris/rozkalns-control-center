# Phase 5 RPi5 observation — source-only activation contract

This document defines the source-level preparation/cutover contract for a future Phase 5 activation. It does not grant LIVE authority. The durable observation architecture and trust boundary remain in [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md); the machine-readable contract is [`.github/phase5-rpi5-observation-activation-contract.json`](../.github/phase5-rpi5-observation-activation-contract.json).

Stable rules:

- `SOURCE_READY_LIVE_UNPROVEN` remains true until current production facts are separately proven.
- `READONLY_PREFLIGHT_EVIDENCE_ONLY` means the preflight receipt is evidence, not permission.
- `MERGE_NOT_DEPLOY_AUTHORITY` means source merge never becomes production authority.
- `EXACT_D1_MIGRATION_CEILING` means a later D1 authorization must name exactly the ordered unapplied set derived from one fresh, exact-main preflight.
- Every mutation class consumes its own authorization at the first authorized mutation. After that point, any tool error, timeout, drift or ambiguity requires STOP; there is no automatic retry, rollback, cleanup or alternate mutation path.

## Read-only input contract

Before any mutation-bearing Phase 5 step, require a fresh successful run of `.github/workflows/phase5-rpi5-observation-readonly-preflight.yml` on exact current `main`, bound to a successful exact-main CI run.

The receipt must include all of these public-safe markers:

- `PHASE5_RPI5_OBSERVATION_PREFLIGHT=PASS`
- `RPI5_REQUEST=NO`
- `QUEUE_MUTATION=NO`
- `REMOTE_D1_MUTATION=NO`
- `WORKER_MUTATION=NO`
- `CLOUDFLARE_CONFIG_MUTATION=NO`
- `SECRET_MUTATION=NO`
- `CLOUDFLARE_MUTATION=NO`
- `LIVE_AUTHORIZATION=NOT_GRANTED`

The expected remote state used by a later authorization is immutable for that one-shot. Re-read it immediately before the first mutation. A changed source SHA, preflight run, Worker state, binding state, migration/schema state or other named prerequisite invalidates the authorization before mutation.

## Exact D1 migration ceiling

The source migration order relevant to this activation is fixed:

1. `0010_webhook_observability_hot_index.sql`
2. `0011_rpi5_observation_replay_claims.sql`
3. `0012_rpi5_production_visibility_projection.sql`
4. `0013_rpi5_observation_atomic_acceptance.sql`

Only three coherent preflight combinations are eligible for planning:

| `0010` / index | `0011`–`0013` / Phase 5 schema | Result |
| --- | --- | --- |
| `ABSENT` / `ABSENT_CONSISTENT` | `ABSENT` / `ABSENT_CONSISTENT` | exact apply set = `0010`, `0011`, `0012`, `0013` |
| `PRESENT` / `PRESENT_VALID` | `ABSENT` / `ABSENT_CONSISTENT` | exact apply set = `0011`, `0012`, `0013` |
| `PRESENT` / `PRESENT_VALID` | `PRESENT` / `PRESENT_VALID` | `NO_D1_APPLY_REQUIRED` |

Every other combination is `STOP_UNKNOWN_PARTIAL_CONTRADICTORY_OR_DRIFTED_STATE`. In particular, later Phase 5 migrations may not be treated as coherent when predecessor `0010` is absent, and no partial `0011`–`0013` history is repair authority.

The fresh #601 preflight that motivated this source contract observed all four migrations absent with matching absent schema/index evidence. That bounded receipt therefore classified the then-current migration ceiling as the exact ordered set `0010`, `0011`, `0012`, `0013`. This statement describes that receipt only; it is not durable production truth and must not be reused for a later LIVE decision without a fresh preflight.

## Separate mutation classes

The activation graph has four mutation-bearing classes. They never cascade automatically.

### 1. D1 apply

Requires a separate owner LIVE authorization naming the exact source SHA, exact preflight run, target production D1 database and exact ordered migration set derived from the preflight classification. The mutation ceiling is only that exact set.

After application, obtain read-only evidence again and require the expected migration/schema state. A failed or ambiguous apply is a STOP, not permission to retry or repair.

The concrete source executor is `.github/workflows/phase5-rpi5-observation-d1-live.yml`. It is `workflow_dispatch` only, runs on exact current `main`, and binds the exact successful push CI run, exact successful read-only preflight run, exact Worker deployment/version, target D1 database and exact ordered migration ceiling. The executor uses `CLOUDFLARE_API_TOKEN` only for Worker GET evidence, `CLOUDFLARE_D1_READ_TOKEN` for D1 GET/SELECT verification, and a dedicated protected `CLOUDFLARE_D1_WRITE_TOKEN` only for the single Wrangler apply command. Secret values are never owner-command inputs or public evidence.

Before `APPLY_STARTED=YES`, the remote `d1_migrations` history must equal the exact source prefix immediately before the authorized ceiling. For the all-absent Phase 5 case this means exactly `0001` through `0009`; if only `0011`–`0013` are authorized, history must be exactly `0001` through `0010` with the reviewed 0010 index present-valid. The source migration directory itself must be exactly `0001` through `0013`, preventing an unreviewed later migration from being swept into Wrangler's apply-all-pending behavior.

Immediately before the one allowed Wrangler mutation, the executor repeats current-main, CI, preflight, Worker baseline, D1 identity, full migration-history and schema/index checks. It then emits `APPLY_STARTED=YES` and `AUTHORIZATION_CONSUMED=YES` before the command. Any later error is `POST_APPLY_STATE=REVIEW_REQUIRED` and STOP with no retry, rollback, cleanup or alternate mutation. Successful postwrite verification requires exact remote history `0001` through `0013`, the reviewed 0010 index, valid Phase 5 table/column probes and empty new Phase 5 tables before ingest activation; the standard read-only Phase 5 preflight must then be rerun as the public-safe receipt.

Future command shape, documented only and not granted here:

`AUTHORIZE LIVE PHASE5 D1 APPLY rozkalns-control-center source_sha=<sha> ci_run=<ci_run_id> preflight_run=<run_id> deployment=<deployment_id> version=<version_id> migrations=<exact_csv> db=rozkalns-control-production`

### 2. Verification-key provisioning

Requires a separate owner LIVE authorization naming exact current-main source SHA, exact successful push CI run, exact successful Phase 5 read-only preflight run, exact active baseline Worker deployment/version, binding `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS` and one public `key_id`.

The concrete source executor is `.github/workflows/phase5-rpi5-observation-verification-key-live.yml`. It is `workflow_dispatch` only and is bound to the dedicated `production-verification-key-live` GitHub Environment. The environment must supply `CLOUDFLARE_API_TOKEN` for Worker GET evidence, a dedicated least-privilege `CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN` used only by the one mutation command, and `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE` as the protected registry payload. This source contract does not create the environment, tokens or secret.

The protected registry must be exact Phase 5 v1 JSON: version `control-phase5-rpi5-verification-keys-v1`, exactly one key entry, exact fields `keyId` and `publicKeyBase64url`, authorized `keyId`, and one canonical 32-byte Ed25519 raw public key encoded as base64url. The registry value is never a dispatch input, command argument, repository value, log field or receipt field. Only the public `key_id` is safe owner-command/audit metadata.

Before `SECRET_PROVISION_STARTED=YES`, the executor revalidates exact current `main`, exact CI/preflight run identity, exact active Worker deployment/version, unchanged `CONTROL_DB`, dormant ingest, target secret absence and the protected registry shape. It repeats the mutable gates immediately before the mutation. The sole mutation is one `wrangler secret put CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS --name rozkalns-control`, with the registry supplied through stdin and the dedicated write token scoped to that child process. Because `wrangler secret put` creates a new Worker version and deploys it immediately, this mutation consumes the authorization before Wrangler is invoked.

Any error after `SECRET_PROVISION_STARTED=YES` is `POST_MUTATION_STATE=REVIEW_REQUIRED` and STOP. There is no retry, rollback, cleanup or alternate mutation. Postwrite GET-only verification requires a new exact deployment/version at 100% traffic, exactly one `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS:secret_text` protected binding, no observed secret value, byte-for-byte canonical equality of the remaining non-secret binding inventory to the baseline, unchanged `CONTROL_DB`, and continued absence of `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED`. The executor contains no D1, Queue, route, DNS, Access or RPi5 mutation path.

Future command shape, documented only and not granted here:

`AUTHORIZE LIVE PHASE5 VERIFICATION KEY PROVISION rozkalns-control-center source_sha=<sha> ci_run=<ci_run_id> preflight_run=<run_id> deployment=<deployment_id> version=<version_id> binding=CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS key_id=<public_key_id>`

### 3. Worker activation

Requires a separate owner LIVE authorization after the D1 and verification-key prerequisites are freshly proven satisfied. It must name exact source SHA, preflight evidence, exact Worker version/configuration/bindings and the intended ingest activation. It may not silently change unrelated bindings, routes, DNS, Access, Tunnel or account configuration.

Post-mutation verification is GET-only evidence for exact active version, traffic, expected bindings and activation state.

Future command shape:

`AUTHORIZE LIVE PHASE5 WORKER ACTIVATE rozkalns-control-center source_sha=<sha> preflight_run=<run_id> worker_version=<version_id> ingest=true`

### 4. RPi5 signer/runtime delivery

This is owned by the `RPi5_main` trust boundary, not by Control. It requires its own explicit owner LIVE authorization under current `RPi5_main` rules and must bind exact Control source/Worker state plus the public key identifier. Control must not create a direct SSH, sudo, root, generic-helper or protected-host inspection shortcut.

Post-mutation evidence is a sanitized signed observation plus Control-side read-only reconciliation; it is not deploy/rollback/DB/host authority.

Future command shape:

`AUTHORIZE LIVE PHASE5 RPI5 SIGNER RUNTIME RPi5_main control_source_sha=<sha> control_worker_version=<version_id> key_id=<public_key_id>`

## One-shot and fail-closed semantics

For every mutation class:

1. re-read exact current source and the named expected remote state;
2. fail before mutation on any mismatch;
3. consume the authorization when the first authorized mutation starts;
4. perform only the named mutation ceiling;
5. on tool error, timeout, unexpected state, ambiguity or drift after mutation starts, preserve bounded read-only evidence and STOP;
6. do not retry, rollback, clean up or choose an alternate mutation without new explicit owner authority;
7. perform the class-specific read-only post-mutation verification before considering the gate satisfied.

Authorization for one class never authorizes another class. Merge never authorizes any of them.

## Explicitly forbidden inheritance and shortcuts

- no secret/private-key value in source, commands, logs or public evidence;
- no direct Control SSH/sudo/root/protected-host path;
- no hidden Queue mutation;
- no Cloudflare mutation outside the exact Worker class scope;
- no cross-class automatic cascade;
- no merge-to-deploy authority inheritance;
- no historical Phase 3/4/Later/Gate authorization replay;
- no automatic retry/rollback/cleanup/alternate mutation after an error.

A source-ready contract is only preparation for later owner decisions. It deliberately stops before the first separately authorized LIVE mutation.
