# Phase 3 Access parent wildcard remediation

Issue: #180  
Refs: #175

## Trigger

The third read-only production PLAN stopped safely before any mutation with:

- `STOP=PLAN_PARENT_APP_DESTINATION`
- `AUTHORIZATION_STATUS=NOT_CONSUMED`
- no deploy/write marker.

A separate read-only diagnostic then proved the exact AUD-selected parent Access application:

- id `235c0666-9e1b-45a2-a7a2-63433c8a2247`
- name `homelab-private`
- type `self_hosted`
- one public destination
- destination URI `*.rozkalns.net`
- expected parent id matched.

No credential, token, JWT or secret was printed.

## External semantics

Cloudflare Access application-path documentation states that a wildcard in the subdomain field matches that specific subdomain level: `*.example.com` covers `alpha.example.com`, but not `example.com` or `foo.bar.example.com`.

The current Cloudflare Access Applications API also states that public destination URIs may contain domain/path wildcards.

Therefore `*.rozkalns.net` legitimately covers the reviewed one-level host `control.rozkalns.net`.

## Source change

`accessApplicationProtectsHost(app, expectedHost)` is a bounded host-coverage proof used only by the Access canary PLAN parent-app check. It accepts:

- exact host coverage;
- exact whole-site `<host>/*`, after existing normalization;
- a leading `*.` wildcard only when it covers exactly one hostname label.

It rejects:

- the apex itself for `*.` coverage;
- deeper/multi-level subdomains;
- partial-label wildcards;
- multiple wildcard labels;
- path-scoped wildcard destinations;
- invalid expected-host shapes.

Webhook detection and activated webhook verification continue to use exact public-destination equality and are intentionally unchanged.

The PLAN sequence remains:

`bounded token AUD hint -> exact self-hosted app by AUD -> documented parent-host coverage -> RS256/JWKS verification -> verified AUD re-bind`

## Trust boundary

This remediation is source/tests/docs only. It does not retry PLAN, does not run APPLY, does not deploy Worker code, does not mutate Access/D1/Queues, does not grow GitHub permissions, and does not change `wrangler.jsonc`.

Baseline: `main=4351edb5fc7e56e8c999f53d6a88914286f25890`, exact-main CI #293 / run `31898011519` = SUCCESS.

**Production deploy: NO.**
