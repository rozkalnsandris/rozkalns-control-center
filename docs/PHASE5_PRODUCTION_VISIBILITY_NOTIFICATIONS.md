# Phase 5 production-visibility notifications

Issue #621 adds a provider-neutral notification transition contract on top of the normalized Phase 5 production-visibility health read model introduced by #620.

The source contract ID is `control-phase5-production-visibility-notification-v1`.

This slice is deliberately read-model only. It does not send Telegram messages, inspect provider credentials, mutate notification targets, write D1/Queues, deploy a Worker, touch Cloudflare/RPi5, or authorize remediation.

## Inputs and trust boundary

`evaluateProductionVisibilityNotificationTransition(previous, current)` consumes only `ProductionVisibilityHealthReadModel` values. Those values already represent sanitized Control-side production visibility such as project/repository identity, exact SHAs, bounded health status, evidence time and age.

This contract does not acquire production evidence and does not independently prove current Worker/RPi5/provider state. Repository source can prove only the intended transition behavior.

A missing current model fails closed with `MISSING_CURRENT_EVIDENCE`. A previous/current project or repository identity mismatch fails closed with `IDENTITY_MISMATCH` rather than constructing a cross-project alert or recovery.

## Notification-worthy transitions

The high-signal alert states are:

- `STALE`
- `DRIFTED`
- `REJECTED`

Entering one of those states from another state emits one `NEW_TRANSITION` candidate with the matching signal.

`HEALTHY` emits a `RECOVERED` candidate only when the immediately previous state was `STALE`, `DRIFTED` or `REJECTED`.

`UNKNOWN` and `NOT_OBSERVED` are never interpreted as healthy recovery. They produce no candidate. Initial or repeated `HEALTHY` also produces no candidate.

## Dedupe and reminder behavior

Repeated observations of the same alert status return `NO_SIGNAL / UNCHANGED`, even when `ageMs` advances. This prevents freshness polling from becoming reminder spam.

There is no periodic reminder timer in this slice. Reminder policy, if ever added, requires a separate explicit source contract instead of being inferred from elapsed time.

The deterministic transition ID includes the signal, sanitized project/repository identity, previous/current status, exact valid SHA diagnostics, canonical observation time and bounded reason codes. It intentionally excludes `ageMs`, so repeated reads of the same observation do not manufacture new dedupe identities merely because time passed.

A later genuine observation has a different `observedAt` and therefore can produce a new transition identity after an intervening recovery.

## Candidate surface

A candidate contains only provider-neutral public-safe presentation and diagnostics:

- schema and contract identifiers;
- signal and deterministic transition ID;
- sanitized project ID and repository;
- bounded `reference`, `title` and `body` fields compatible with the existing notification presentation pattern;
- current and previous normalized health status;
- valid 40-hex `mainSha` / `productionSha` when available, otherwise `null`;
- canonical `observedAt` when available, otherwise `null`;
- integer freshness in seconds when valid, otherwise `null`;
- bounded normalized health reason codes;
- Control deep link `/#projects-title`, which lands in the existing Projects / production-visibility section.

The candidate intentionally does not contain runtime/rollback/blocker internals, protected raw observation payloads, signatures, key IDs, delivery/replay identities, claim tokens, credentials, provider tokens, privileged action tokens, or remediation authority.

The existing decision notification delivery envelope remains decision-specific and is not widened here. This contract reuses the existing provider-neutral notification text sanitization and presentation shape without changing any Telegram/D1 delivery schema or runtime wiring.

## Authority boundary

A `NEW_TRANSITION` is evidence for notification orchestration only. It does not grant authority to:

- deploy or promote a Worker;
- write/migrate production D1;
- write/replay/configure Queues;
- mutate Cloudflare settings;
- mutate an RPi5 host;
- change Telegram/provider secrets or targets;
- invoke a live Control mutation;
- perform automatic remediation or rollback.

Any such action remains behind its existing separate owner authorization and production trust boundary.

## Regression coverage

`tests/production-visibility-notification.test.ts` covers:

- entry into all three alert statuses;
- unchanged-state dedupe despite increasing freshness age;
- alert-to-alert transitions;
- recovery only from an alert state;
- missing/unknown/not-observed fail-closed behavior;
- cross-project continuity rejection;
- bounded sanitization and protected-field exclusion;
- deterministic dedupe identity and new-observation re-entry behavior.
