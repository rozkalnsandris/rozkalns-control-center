# Phase 4 Telegram post-resume read-only observation

This document defines the source contract for observing Telegram delivery after a successful Gate B Queue resume. It does not authorize or perform any production mutation.

## Trigger

Successful Gate B run `33957463775` completed on exact main and emitted `NEXT_ACTION=READ_ONLY_POST_RESUME_OBSERVATION`. Gate B resumed the reviewed dispatch Queue exactly once and then performed only post-write read-only confirmation.

The Gate B prewrite evidence bound 19 durable notification intents while the paused Queue held 1493 messages. The observed Telegram drain produced 19 messages and then stopped. This is consistent with the reviewed replay-safe model: Queue backlog messages are replay work, while durable D1 intents and attempt/claim state determine provider eligibility.

## Observer workflow

`.github/workflows/phase4-telegram-post-resume-readonly-observation.yml` is manual, main-only and runs in `production-readonly-reconcile`.

It requires exact identifiers from the completed Gate B envelope:

- Gate B run id;
- Worker deployment and version;
- dispatch Queue id and consumer id;
- exact pre-resume D1 intent count.

The observer first proves that its own `GITHUB_SHA` is current `main` and has a successful exact-main CI run.

The supplied Gate B run is historical evidence and therefore retains the immutable `head_sha` on which that LIVE run actually executed. The observer does **not** require this historical SHA to equal the later observer `main` SHA. Instead it validates the exact Gate B run identity, path, `main` branch, `workflow_dispatch`, `run_attempt=1`, and successful terminal conclusion; captures its `head_sha`; then uses GitHub's read-only Compare commits endpoint to prove that Gate B SHA is an ancestor of the observer's current `main` SHA. The comparison must report the Gate B SHA as both the base commit and merge base, with current observer `main` ahead of it.

This permits legitimate source-only advancement after Gate B while failing closed if the observer is run from an unrelated or rewritten history. It also preserves exact current-main and final anti-drift checks.

Observer run `33958539860` exposed the previous incorrect equality rule and stopped with `GATE_B_RUN_INVALID` before any Cloudflare, D1, Queue, Worker or Telegram mutation. That failed read-only run must not be used as evidence of delivery settlement; the corrected observer must be run fresh after the source fix is merged.

After provenance is established, the workflow re-proves the Worker deployment/version and reviewed notification bindings.

## D1 observation boundary

D1 access uses only `CLOUDFLARE_D1_READ_TOKEN`. Every remote D1 query is one guarded `SELECT` statement and must report `changed_db=false`, `rows_written=0` and `changes=0`.

The observer uses the trusted Gate B **run start timestamp** as the cutoff for the historical intent set. Gate B revalidated the exact pre-resume intent count later in that same run before the Queue resume; therefore a successful Gate B run proves there was no intent-count drift between run start and prewrite. Using the earlier run-start boundary also excludes any new live intents created after the provider-delivery run began.

It requires that this bound intent count equals the Gate B pre-resume count, then observes attempts and durable dispatch claims for that set.

Structural evidence fails closed if an attempt lacks its corresponding claim or a claim lacks its corresponding attempt. The observer classifies each Gate-B-bound intent by its latest durable attempt as:

- delivered;
- terminal failure;
- exhausted after the reviewed maximum attempts;
- unsettled.

A successful settled observation requires zero unsettled Gate-B-bound intents. Newer notification intents created after Gate B started are excluded from that historical settlement classification and remain normal live traffic.

## Queue observation

The exact dispatch Queue must remain resumed and the exact reviewed Worker consumer topology must remain valid. Queue backlog count, bytes and oldest-message timestamp are emitted as best-effort point-in-time evidence.

A non-zero Queue backlog does not by itself fail the observation because it may represent replay work or newer live work. The workflow emits whether the Queue replay backlog is currently empty, but durable D1 settlement remains the provider-delivery authority.

## Mutation ceiling

The observer authorizes and performs zero:

- Queue pause/resume/create/delete/purge/pull/peek/ACK or consumer mutations;
- D1 writes or migrations;
- Worker upload/deploy/promotion;
- secret/token changes;
- direct Telegram API requests;
- rollback or cleanup.

No LIVE authorization is required because the workflow is GET/SELECT-only. Gate B run `33957463775` is terminal and must never be rerun.

After a successful observation, the next step is source/canonical continuity review. Any future production mutation requires a new exact owner authorization for that mutation boundary.
