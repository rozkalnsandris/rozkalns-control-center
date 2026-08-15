# Phase 3 Access auth canary PLAN AUD remediation

## Trigger

The first production PLAN under #175 stopped before any write with:

- `STOP=PLAN_PARENT_APP`
- `AUTHORIZATION_STATUS=NOT_CONSUMED`
- `PLAN_RC=1`

No Worker deploy, Access policy change, D1 mutation or Queue mutation started.

## Root cause

The original combined production gate discovered the parent Access application by exact public hostname before binding discovery to the short-lived Access token's application Audience (`aud`). That is stricter than necessary in the wrong dimension: Cloudflare Access applications may express public destinations with hostname/path combinations, while the JWT `aud` is the application-specific Audience tag used for token validation.

The production failure therefore did not indicate an invalid JWT or broken Access policy. It indicated that hostname-only inventory discovery did not uniquely identify the parent application.

## Corrected PLAN-only discovery

`scripts/cloudflare-access-auth-canary-plan.mjs` is intentionally incapable of APPLY or Worker deployment.

Its discovery order is:

1. read exactly one bounded application AUD from the short-lived Access token as an **untrusted lookup hint**;
2. resolve exactly one self-hosted Access application with that AUD;
3. prove the selected application includes the reviewed `control.rozkalns.net` public destination;
4. parse the token again against the selected application AUD;
5. validate the issuer as an exact `https://<team>.cloudflareaccess.com` origin;
6. fetch only `<issuer>/cdn-cgi/access/certs`;
7. verify the token's RS256 signature with the unique matching signing JWK;
8. re-bind the cryptographically verified AUD to the AUD-selected application;
9. only then emit the production authorization evidence.

The unverified AUD is never sufficient for authorization. It is used only to select the candidate application whose identity is then cryptographically re-proven.

## Preserved production gates

The PLAN still requires:

- exact `main` SHA;
- successful exact-main push CI;
- clean local `main` matching `origin/main`;
- reviewed pre-activation Worker binding set;
- exact active Worker version/deployment;
- workers.dev and preview URLs disabled;
- exact Custom Domain;
- exact main Queue + DLQ topology and consumers;
- protected `/api/health` success;
- `/api/auth/access-canary` absent or fail-closed disabled;
- environment-only Cloudflare API token and short-lived Access token.

## Authorization compatibility

The PLAN emits the exact field order consumed by the existing APPLY gate:

`authorize Phase 3 Access auth canary <host> <sha> ci <run> version <version> deployment <deployment> domain <domain> access <app> aud <aud> issuer <issuer> mainq <queue> mainc <consumer> dlq <dlq> dlqc <consumer> inactive`

The APPLY gate remains unchanged and remains separately owner-authorized.

## Trust boundary

This remediation is source/tests/docs only. Merging it does not execute production PLAN and does not authorize APPLY.

**Production deploy: NO.**
