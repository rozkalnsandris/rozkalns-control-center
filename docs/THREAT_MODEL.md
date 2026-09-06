# Threat Model

Rozkalns Control is an internet-facing approval/control plane. The primary security objective is to prevent stale, forged, replayed, duplicated, over-broad or unavailable evidence from becoming unintended GitHub or production authority.

Repository source/configuration proves intended defenses only. It does not prove that the active production Worker, bindings, secrets, D1/Queue state, provider configuration or RPi5 runtime currently matches source.

## Assets to protect

- GitHub repositories and branch history;
- PR merge/review authority;
- GitHub App private key, installation tokens and webhook secret;
- Cloudflare Access identity/authorization;
- decision and idempotency audit evidence;
- D1 reconciliation/notification/continuation state;
- Telegram provider credential and target binding;
- production/RPi5 credentials and control paths;
- sanitized Phase 5 production evidence/provenance;
- notification channels and deep links;
- future provider credentials.

## Trust boundaries

1. Browser ↔ Cloudflare Access/Worker.
2. GitHub webhook sender ↔ public webhook ingress.
3. Worker ↔ GitHub API.
4. Worker ↔ D1 / Queues / secrets.
5. Worker notification dispatcher ↔ Telegram provider/target.
6. RPi5 sanitized evidence producer ↔ read-only transport ↔ Control Phase 5 consumer (producer/transport pending).
7. Public GitHub content ↔ trusted control logic.

## Threats and mitigations

### Forged human request

Threat: an attacker directly calls a protected decision endpoint.

Mitigations:

- Cloudflare Access in front of human UI/API;
- Worker verifies signed Access JWT, expected issuer/JWKS/audience and allowed identity;
- authorization checked server-side, never UI-only;
- project capabilities and current state remain independent fail-closed gates.

### Forged GitHub webhook

Threat: an attacker sends fake PR/CI/reconciliation state.

Mitigations:

- verify GitHub HMAC over raw request bytes before payload trust;
- reject missing/invalid signatures;
- secrets stored only in secret bindings;
- repository identity comes from the authenticated payload;
- re-resolve authoritative GitHub state before any protected mutation.

### Webhook / Queue duplicate or replay

Threat: GitHub retry, Queue at-least-once delivery or HTTP retry causes duplicate processing/action.

Mitigations:

- unique GitHub delivery IDs and durable delivery lifecycle;
- idempotency keys/consumed decision state for side effects;
- bounded retry behavior;
- duplicate reconciliation messages must converge through durable state instead of replaying a protected action;
- notification dispatch uses deterministic intents/claims/attempt state rather than treating each Queue delivery as new authority.

### Queue ordering assumption

Threat: correctness depends on messages arriving in publication order, causing a newer state to be overwritten or an old transition to run after a newer one.

Cloudflare Queues does **not** guarantee message ordering. `max_concurrency = 1` is only a processing bound and must not be interpreted as ordering authority.

Mitigations:

- Queue messages are triggers, never canonical state;
- domain/D1 state transitions and exact identities determine sequencing;
- authoritative GitHub rereads determine current repository state;
- stale/contradictory lifecycle transitions fail closed;
- idempotency makes duplicate/out-of-order handling safe.

### Stale merge approval

Threat: a user approves one PR head and code/state changes before merge.

Mitigations:

- bind approval to exact expected head SHA;
- reload live PR immediately before mutation;
- revalidate CI/review/policy and target/base validity;
- use expected-head merge protection where supported;
- fail closed if any binding changed.

### Over-privileged GitHub App

Threat: a compromised control plane can mutate more than required.

Mitigations:

- dedicated Control App, separate from RPi5 Automation;
- least privilege by capability/phase;
- selected repositories only;
- short-lived installation tokens narrowed to exact repository/permissions where useful;
- unsupported project/operation combinations disabled by source policy;
- no broad source-write permission for future convenience.

### Public issue/PR prompt or instruction injection

Threat: malicious repository text asks an assistant/worker to invoke privileged operations.

Mitigations:

- treat public repository content as untrusted data;
- authority comes only from authenticated owner action plus canonical policy/state;
- never turn issue/PR prose into implicit MERGE/LIVE authority;
- protected endpoints enforce capabilities and state transitions server-side.

### Secret leakage

Threat: credentials reach source, D1, logs, fixtures, screenshots or public evidence.

Mitigations:

- secrets only in approved platform/host secret storage;
- raw credential material excluded from domain/business models;
- structured logs omit protected headers/bodies/query values/secrets;
- no private keys/tokens/provider secrets in D1;
- public-repository secret scanning and focused diff review.

### D1 quota exhaustion or storage-service unavailability

Threat: D1 daily limits or service failure prevents current persistence/reconciliation reads/writes, and control logic incorrectly treats missing state as safe/authorized.

Workers Free-plan daily D1 row-read and row-write limits are enforced; exhausted queries fail until the daily reset. Ordinary service failures may create the same evidence-unavailable condition.

Mitigations:

- persistence/reconciliation failure is an explicit fail-closed operational state;
- protected actions must not infer approval, freshness, idempotency or successful reconciliation when required D1 evidence is unavailable;
- bounded error/health evidence may remain observable without exposing credentials/data;
- query/index design should minimize unnecessary scans, but resource pressure must never weaken authorization semantics;
- no automatic production mutation/retry is introduced merely to recover from quota failure.

### Telegram provider or target misbinding

Threat: a valid notification is sent to the wrong Telegram target, a stale target configuration remains active, or a compromised bot credential permits unauthorized notification activity.

Mitigations:

- source-controlled logical target keys, not caller-supplied arbitrary destination authority;
- provider secret and concrete target identifier remain in protected runtime configuration/secret bindings;
- dispatch validates the expected configured target/provider boundary and fails closed on missing/malformed configuration;
- notification content contains bounded identifiers/deep links, not privileged action tokens or credentials;
- changing provider credentials/target binding is a separate live/credential operation, not implied by source merge.

### Notification replay / duplicate dispatch

Threat: a Queue duplicate, retry or stale transition sends the same decision notification repeatedly or after the underlying state has changed.

Mitigations:

- deterministic transition/intent identity;
- durable claim/attempt state and bounded retries;
- `Later` and equivalent state suppress unchanged notification spam without implying approval;
- the notification itself never authorizes a mutation; the user must enter the Access-authenticated Control flow where current evidence is revalidated.

### Queue/DLQ loss or retry exhaustion

Threat: failed reconciliation silently disappears or repeated failures become an uncontrolled loop.

Mitigations:

- bounded retries;
- Dead Letter Queue / bounded terminal evidence;
- explicit blocked/attention state;
- no retry/requeue/delete/cleanup authority from the read-only dashboard;
- recovery mutation requires the separately defined gate rather than being inferred from failure.

### Control plane bypasses production safeguards

Threat: a Merge/UI/Phase 5 path directly mutates RPi5, production DB/config or deployment state.

Mitigations:

- no direct Control SSH/sudo/root path;
- merge and deploy are separate authorities;
- RPi5 remains exact-SHA/deploy-class/health/rollback authority;
- Phase 5 is read-only/sanitized evidence first;
- dangerous production capabilities default false;
- normalized production evidence is observational and cannot become deploy/rollback authority.

### Forged or stale Phase 5 producer evidence

Threat: Control accepts a payload that names the wrong project/repository/SHA, is stale, contains contradictory runtime/health state, or was fabricated outside the reviewed RPi5 producer boundary.

Mitigations:

- exact managed-project/repository identity validation;
- strict SHA and freshness/state validation;
- exact top-level allowlist and nested schema validation;
- reject unknown/extra/inherited/non-enumerable/symbol properties rather than silently dropping them;
- reject contradictory/unsupported values fail closed;
- source consumer never synthesizes missing production evidence.

### Over-broad Phase 5 producer or transport

Threat: the producer leaks protected host data or becomes a generic remote-inspection/control channel.

Mitigations:

- producer contract must be defined in the owning `RPi5_main` trust boundary;
- strict source allowlist + sanitization equivalent-or-tighter than the Control consumer;
- bounded read-only transport reviewed separately from producer source;
- no direct Control SSH, sudo, root, generic helper, arbitrary filesystem/runtime/config reads, DB access or host credentials;
- only public-safe/sanitized metadata crosses the boundary;
- producer evidence never conveys production mutation authority.

### Producer provenance drift

Threat: Control consumes data from an unreviewed producer version or a producer whose sanitization contract changed independently.

Mitigations:

- bind producer contract/provenance to canonical RPi5 source and reviewed schema/version evidence;
- fail closed on unknown schema/provenance or contract drift;
- revalidate the producer/transport boundary before live activation/cutover;
- repository source alone is not proof that the corresponding producer is active on the host.

## Future AI-specific threats

AI execution is not MVP. Before enabling it, extend this threat model for:

- untrusted code execution;
- provider prompt/data leakage;
- workspace escape;
- credential proxy/scoping;
- runaway cost/resource use;
- autonomous permission escalation.

No AI runtime should receive production credentials.

## Review trigger

Update this threat model whenever a phase adds or materially changes a trust boundary, permission, credential type, provider/external service, storage/Queue semantics, producer/consumer evidence contract or side-effecting action.
