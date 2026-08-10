# Threat Model

Rozkalns Control is an internet-facing approval plane. The primary security objective is to prevent stale, forged, replayed or over-privileged input from becoming an unintended GitHub or production mutation.

## Assets to protect

- GitHub repositories and branch history;
- PR merge/review authority;
- GitHub App private key and webhook secret;
- Cloudflare Access identity/authorization;
- approval audit evidence;
- production/RPi5 credentials and control paths;
- notification channels and deep links;
- future provider credentials.

## Trust boundaries

1. Browser ↔ Cloudflare Access/Worker.
2. GitHub webhook sender ↔ public webhook ingress.
3. Worker ↔ GitHub API.
4. Worker ↔ D1/Queues/Workflows/secrets.
5. Control Center ↔ RPi5 production plane (future read-only first).
6. Public GitHub content ↔ trusted control logic.

## Threats and mitigations

### Forged human request

Threat: attacker directly calls a mutation endpoint.

Mitigations:

- Cloudflare Access in front of human UI/API;
- Worker verifies signed Access JWT, issuer/JWKS/audience and allowed identity;
- authorization checked server-side, never UI-only.

### Forged GitHub webhook

Threat: attacker sends fake PR/CI state.

Mitigations:

- verify GitHub HMAC over raw request bytes before payload trust;
- reject missing/invalid signatures;
- secrets stored only in secret bindings;
- re-resolve GitHub before any protected mutation.

### Replay / duplicate delivery

Threat: webhook retry or HTTP retry causes duplicate action.

Mitigations:

- unique GitHub delivery IDs;
- idempotency keys for side effects;
- durable consumed approval state;
- bounded queue/workflow retry behavior.

### Stale merge approval

Threat: user approves one PR head, code changes before merge.

Mitigations:

- bind approval to exact expected head SHA;
- reload live PR immediately before mutation;
- revalidate CI/review/policy;
- expected-head merge protection where supported;
- fail closed if any binding changed.

### Over-privileged GitHub App

Threat: compromised control plane can mutate more than needed.

Mitigations:

- dedicated app, separate from RPi5 verifier app;
- least privilege by phase;
- selected repositories only;
- short-lived installation tokens;
- narrow repository/permission scope where possible;
- no source-write permission until a future phase requires it.

### Public issue/PR prompt/instruction injection

Threat: malicious text asks an assistant/worker to invoke privileged operations.

Mitigations:

- treat repository text as untrusted data;
- authority comes only from authenticated policy/state/owner action;
- never turn issue text into implicit approval;
- protect mutation endpoints with explicit capabilities and state transitions.

### Secret leakage

Threat: credentials reach source, D1, logs or artifacts.

Mitigations:

- secrets only in platform secret storage;
- structured redaction;
- no raw protected config in logs;
- public repo secret scanning in CI when added;
- review diffs/artifacts before merge.

### Control plane bypasses production safeguards

Threat: a Merge or UI button mutates RPi5/DB directly.

Mitigations:

- no direct SSH/sudo path in MVP;
- merge and deploy are separate authorities;
- RPi5 remains exact-SHA/deploy-class authority;
- read-only production adapter first;
- production write capabilities default false.

### Queue/workflow loss

Threat: failed reconciliation silently disappears.

Mitigations:

- bounded retries;
- Dead Letter Queue;
- explicit blocked/error state;
- notification for non-auto-recoverable control failures.

### Notification abuse

Threat: notification contains privileged token/action or repeats noisily.

Mitigations:

- notifications carry deep links/identifiers, not credentials;
- mutation still requires authenticated Control Center request;
- deduplicate by meaningful state transition;
- `Later` suppresses spam without implying approval.

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

Update this threat model whenever a phase adds a new trust boundary, permission, credential type, external service or side-effecting action.
