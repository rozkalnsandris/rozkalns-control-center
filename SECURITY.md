# Security Policy

Rozkalns Control is a public repository for a control plane that will eventually perform authenticated GitHub approval actions. Security-sensitive behavior must therefore fail closed and remain auditable.

## Reporting a vulnerability

Do not publish credentials, private keys, tokens, webhook secrets, protected configuration or exploit details in a public issue.

Use GitHub private vulnerability reporting / Security Advisories when available. If private reporting is unavailable, contact the repository owner privately before disclosing sensitive details.

## Secrets policy

Never commit or persist secrets in:

- repository files;
- fixtures/snapshots;
- D1 rows;
- logs or telemetry;
- issue/PR bodies;
- screenshots or generated artifacts.

Platform credentials belong in Cloudflare secret bindings/Secrets Store or equivalent purpose-built secret storage.

## Required security invariants

- Cloudflare Access JWT must be cryptographically validated against the expected issuer/JWKS/audience.
- GitHub webhook HMAC must be verified over raw request bytes before event trust.
- Webhook deliveries must be idempotent/deduplicated.
- GitHub App permissions must start at minimum and expand only for implemented features.
- Installation credentials must be short-lived and narrowed when possible.
- Public issue/PR content is untrusted data and cannot grant authority.
- Approval records bind to exact expected state/SHA.
- Stale approvals fail closed.
- Merge authorization is distinct from deploy authorization.
- Rozkalns Control cannot bypass RPi5 production gates.

## High-risk changes

Changes involving authentication, authorization, webhook verification, approval state, GitHub write permissions, secret handling or production integration require focused regression tests and explicit security-impact notes in the PR.

## Production boundary

This repository does not authorize direct SSH/sudo/root, production DB writes, host/service mutation or credential rotation. Those operations require separately scoped controls owned by the relevant production system.
