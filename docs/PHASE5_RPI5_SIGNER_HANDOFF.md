# Phase 5 Control-to-RPi5 signer handoff contract

This document defines the **Control-side source contract** for handing one exact, public-safe expected Worker identity to the separately owned `RPi5_main` `RPI5_SIGNER_RUNTIME` lane.

It is not production evidence and it is not authorization. `SOURCE_READY_LIVE_UNPROVEN` and `MERGE_NOT_DEPLOY_AUTHORITY` remain in force. Creating, validating, committing or merging a handoff manifest does not authorize RPi5 access, signer/private-key setup, host/runtime changes, Worker/D1/Queue/Cloudflare mutation, credential changes or cross-repository writes.

The strict validator is [`src/shared/phase5-rpi5-signer-handoff.ts`](../src/shared/phase5-rpi5-signer-handoff.ts). The parent Phase 5 activation contract remains [`.github/phase5-rpi5-observation-activation-contract.json`](../.github/phase5-rpi5-observation-activation-contract.json).

## Ownership boundary

The receiver is fixed to:

- repository: `rozkalnsandris/RPi5_main`;
- lane: `RPI5_SIGNER_RUNTIME`;
- authority owner: `RPi5_main`.

Control is verifier/orchestration source only at this boundary. It must not create a direct SSH, sudo, root, generic-helper or protected-host inspection path. The current `RPi5_main` rules and automation master plan remain authoritative for any later signer/private-key/runtime delivery.

Before a future RPi5-owned LIVE action, `RPi5_main` must freshly revalidate its own current rules, exact target/source identities, cross-repository compatibility and required owner authorization. A Control manifest is input evidence to that process, never a substitute for it.

## Exact manifest contract

Contract identifier: `PHASE5_RPI5_SIGNER_HANDOFF_V1`.

Schema version: `1`.

The manifest admits exactly these fields and no others:

| Field | Required value / validation |
| --- | --- |
| `schema_version` | literal `1` |
| `contract` | literal `PHASE5_RPI5_SIGNER_HANDOFF_V1` |
| `source_repository` | literal `rozkalnsandris/rozkalns-control-center` |
| `control_source_sha` | exact lowercase 40-hex Control source SHA |
| `worker` | literal `rozkalns-control` |
| `expected_worker.deployment_id` | exact Worker deployment UUID |
| `expected_worker.version_id` | exact Worker version UUID |
| `expected_worker.traffic_percent` | literal `100` |
| `expected_worker.ingest_state` | literal `PRESENT_TRUE` |
| `key_id` | public identifier matching the bounded key-id syntax; no key value |
| `observation_contract_version` | literal `control-phase5-rpi5-observation-v1` |
| `generated_at` | canonical UTC ISO timestamp within the bounded freshness window |
| `receiver.repository` | literal `rozkalnsandris/RPi5_main` |
| `receiver.lane` | literal `RPI5_SIGNER_RUNTIME` |
| `receiver.authority_owner` | literal `RPi5_main` |
| `authority.evidence_only` | literal `true` |
| `authority.grants_live_authority` | literal `false` |
| `authority.grants_cross_repo_write` | literal `false` |
| `authority.grants_rpi5_runtime_mutation` | literal `false` |

The validator rejects non-plain objects, arrays where records are required, missing fields, additional fields at any nesting level, malformed identifiers, unsupported protocol versions, any Worker traffic other than 100%, any ingest state other than `PRESENT_TRUE`, receiver/owner drift and any attempt to turn the authority flags into permission.

## Freshness and exact identity

`generated_at` must be canonical UTC ISO-8601 in the exact form produced by `Date.prototype.toISOString()`. The handoff is valid for at most **300 seconds** and is rejected if future-dated.

The 300-second ceiling deliberately matches the existing Phase 5 observation transport freshness bound. It does not make runtime evidence durable: a future action must still freshly obtain and validate current facts under the owning repository's rules.

The caller must bind the normalized handoff to the exact expected tuple before relying on it:

- Control source SHA;
- Worker deployment ID;
- Worker version ID;
- public `key_id`.

Any mismatch fails closed. The fixed schema additionally binds Worker traffic to 100%, ingest to active `PRESENT_TRUE`, the observation protocol version, receiver repository/lane and no-authority flags.

## Where Worker identity comes from

This contract does **not** infer production state from repository source or `wrangler.jsonc`.

Before producing a handoff for a later RPi5-owned action, current Worker facts must come from fresh, reviewed read-only evidence compatible with the merged Phase 5 post-activation verifier contract. That evidence must prove the exact active deployment/version at 100% traffic and ingest active as expected. Protected verification-key material remains opaque; only the public `key_id` is admitted to this handoff.

A historical preflight, activation receipt, source commit or merged PR must not be substituted for current Worker evidence.

## Public-safe data boundary

The exact-field schema intentionally has no place for protected material or host detail. Do not extend the manifest with:

- signing, private or verification-key values;
- credentials, tokens, passwords or secret payloads;
- hostnames, addresses, SSH targets or user identities used for host access;
- filesystem paths or protected configuration locations;
- systemd/service/container/process details;
- raw configuration, command output, logs or environment values;
- database contents or Queue payloads;
- rollback commands, helper invocation details or mutation instructions.

If future RPi5 implementation needs another field, that is a source-contract change requiring fresh review. Unknown fields fail closed rather than being ignored.

## No-authority semantics

A valid manifest means only:

> Control has produced a syntactically strict, fresh, exact-identity, public-safe statement of the Worker state that a separately authorized RPi5 signer/runtime operation is expected to target.

It does **not** mean:

- the stated Worker state is still current after the freshness window;
- the RPi5 signer/runtime is installed, configured, healthy or authorized;
- a signing/private key exists or may be read/provisioned;
- Control may write to `RPi5_main`;
- Control may invoke an RPi5 helper or inspect the host;
- Worker, D1, Queue, Cloudflare, secret or credential mutation is permitted;
- merge creates deploy/LIVE authority.

## Separate RPi5 owner/LIVE gate

The parent Phase 5 source contract documents the future command shape only:

`AUTHORIZE LIVE PHASE5 RPI5 SIGNER RUNTIME RPi5_main control_source_sha=<sha> control_worker_version=<version_id> key_id=<public_key_id>`

That text is **not standing authorization**. A future invocation must satisfy the then-current `RPi5_main` rules and must be explicitly issued by the owner with fresh exact identities. `RPi5_main` may require additional source/evidence fields or a different exact authorization protocol at that time; its current contract governs.

No Control-side command may silently cascade into that RPi5 LIVE class.

## Post-runtime evidence

If a separately authorized RPi5-owned signer/runtime delivery eventually succeeds, the acceptable cross-boundary proof remains sanitized signed observation evidence followed by Control-side read-only reconciliation. Observation evidence is not deploy, rollback, DB, Queue, credential or host authority.

## Regression coverage

`tests/phase5-rpi5-signer-handoff.test.ts` covers:

- valid normalization and exact identity matching;
- exact top-level and nested field sets;
- SHA, UUID, traffic, ingest and key-id validation;
- fixed observation protocol version;
- 300-second freshness, future-time rejection and canonical timestamp format;
- immutable receiver/authority literals;
- exact source/deployment/version/key identity drift;
- non-echoing fail-closed errors.

Fixtures are synthetic/public and must never be replaced with production credentials or key material.
