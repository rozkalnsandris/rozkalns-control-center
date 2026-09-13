# Phase 5 RPi5 observation verification-key reconciliation

This document defines the source-only post-activation reconciliation path for `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS`.

It exists because the original verification-key provisioner is deliberately limited to the dormant baseline: the target secret must be absent and observation ingest must not yet be active. Once the Worker is already active with `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED=true` and the target binding present as protected `secret_text`, that initial one-shot must not be replayed.

The machine contract is `.github/phase5-rpi5-observation-verification-key-reconcile-contract.json`. The future LIVE workflow is `.github/workflows/phase5-rpi5-observation-verification-key-reconcile-live.yml`, executed by `scripts/phase5-rpi5-observation-verification-key-reconcile-live.mjs`.

## Authority boundary

Repository source defines intended validation and mutation ceilings only. It does not prove current production state and does not grant LIVE authority.

A future reconciliation requires a separate explicit owner authorization after all of the following are freshly true on the exact current `main` SHA:

- exact-main CI is successful;
- a first-attempt `Phase 5 RPi5 observation Worker post-activation GET-only verify` run is successful on that same SHA;
- the active Worker deployment/version exactly matches the approved verifier baseline;
- traffic is one version at 100%;
- `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` is exact `plain_text=true`;
- `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS` is present only as protected `secret_text`; its value is never read;
- `CONTROL_DB` still points to the reviewed production D1 database;
- current runtime compatibility configuration matches source.

The public RPi5 credential receipt contributes only `key_id` and canonical raw Ed25519 `publicKeyBase64url`. Both are public-safe. The executor validates the 32-byte canonical Ed25519 encoding, constructs the exact one-key v1 registry in memory, and binds owner authorization to SHA-256 of the raw public key bytes. No GitHub Environment registry-value secret is required.

## One-shot mutation ceiling

The first and only authorized mutation is one:

`wrangler secret put CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS --name rozkalns-control`

The registry value is passed on stdin and is never printed. The dedicated `CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN` is exposed only to that command.

Cloudflare documents that `wrangler secret put` creates a new Worker version and deploys it immediately. For this path that behavior is intentional and therefore part of the reviewed LIVE mutation class. The executor marks authorization consumed immediately before invoking the command.

No D1, Queue, routes, DNS, Access, GitHub Environment, RPi5, or other Worker binding mutation is in scope. No retry, rollback, cleanup, or alternate mutation is automatic.

## Post-write verification

After the single command succeeds, GET-only evidence must prove:

- a new active deployment and new active version exist;
- that version has 100% traffic;
- ingest remains exact `plain_text=true`;
- the verification-key binding remains present only as protected `secret_text` with value unobserved;
- every non-target binding is byte-for-byte equivalent under canonicalized metadata comparison;
- `CONTROL_DB` remains unchanged;
- compatibility date/flags remain identical to the reviewed baseline/current source.

Any post-mutation error, timeout, drift, or ambiguity emits `POST_MUTATION_STATE=REVIEW_REQUIRED` and stops. It must not retry, roll back, clean up, or choose another mutation path without fresh owner authorization.

## Future owner authorization format

The exact future command is produced only after merge, exact-main CI, and a fresh post-activation GET-only verifier:

```text
AUTHORIZE LIVE PHASE5 VERIFICATION KEY RECONCILE rozkalns-control-center source_sha=<sha> ci_run=<ci_run_id> post_activation_verify_run=<run_id> deployment=<deployment_id> version=<version_id> binding=CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS key_id=<public_key_id> public_key_sha256=<sha256_of_raw_ed25519_public_key>
```

Merge is not LIVE authorization. The public key receipt is not LIVE authorization. A successful GET-only verifier is not LIVE authorization.
