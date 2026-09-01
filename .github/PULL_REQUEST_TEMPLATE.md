## Summary

<!-- Why does this change exist? Link the task/issue and master phase. -->

Refs #

## Current phase / master alignment

- Master issue #1 re-read: yes/no
- Current phase:
- Exit criterion advanced by this PR:
- Execution lane/mode: FAST-LANE v2.2 / AUTO-RUN FULL / GITHUB-ONLY / other

## Scope

<!-- Exact files/behavior changed. Keep unrelated cleanup out. FAST may batch only closely related same-risk work that forms one coherent acceptance story. -->

## Risk

- Runtime effect: NONE / READ_ONLY / MUTATION
- Authentication/authorization changed: yes/no
- GitHub App permission or trust-boundary changed: yes/no
- Webhook/approval/idempotency behavior changed: yes/no
- Secrets handling changed: yes/no
- Migration required: yes/no

Explain every `yes` answer and any material failure mode.

## Testing

- [ ] focused validation
- [ ] typecheck (when applicable)
- [ ] lint (when applicable)
- [ ] unit tests (when applicable)
- [ ] build (when applicable)
- [ ] final diff reviewed for accidental files/secrets

Commands/results:

```text
...
```

## Review

- Automated review/check state:
- Human review state:
- Unresolved review threads:
- Final scope/diff reviewed: yes/no

## Deploy impact

- Deploy required: YES / NO
- Cloudflare production deploy authorized by this PR: **no unless explicitly stated and separately approved**
- RPi5/production mutation: **no unless explicitly stated and separately approved**
- DB migration/write: **no unless explicitly stated and separately approved**

Merge authority must come from the active lane/issue contract. Merge never authorizes deploy, DB/Queue writes, permission or trust-boundary changes, Cloudflare infrastructure mutation, secrets/credentials, or host mutation.

## Ready receipt

- Base / current main:
- Exact head SHA:
- CI/checks:
- Unresolved review threads:
- Reviewed scope/diff:
- Security/deploy/migration classification:
- Exact next gate:

## Explicit non-goals

<!-- State important things this PR deliberately does not change. -->

## Rollback / failure behavior

<!-- For mutation/security changes, explain fail-closed, retry, rollback and idempotency behavior. -->
