# Phase 3 Access auth canary destination remediation

## Trigger

The second read-only production PLAN retry under #175 stopped before any mutation with:

- `STOP=PLAN_PARENT_APP_DESTINATION`
- `AUTHORIZATION_STATUS=NOT_CONSUMED`
- `PLAN_RC=1`

No Worker deploy, Access application mutation, D1 write or Queue mutation started.

## Root cause

The AUD-bound remediation from #176/#177 correctly identified one self-hosted Access application by the short-lived token's application Audience. The next source assertion still required `accessApplicationPublicUris(parent).includes(HOSTNAME)`.

Two details made the helper stricter than Cloudflare's current API contract:

1. public destination `type` is optional in the Access Applications API, but the helper required `type === "public"`;
2. an application that protects a whole public hostname may be represented as either `control.rozkalns.net` or `control.rozkalns.net/*`, while the helper preserved the latter literally.

Cloudflare documents `destinations` as the current application destination model and states that public destination URIs may contain subdomain/path wildcards. Its Access application-path documentation specifically treats a bare hostname and the same hostname with `/*` as equivalent whole-site protection forms.

## Remediation

`accessApplicationPublicUris()` now:

- accepts a destination with a bounded `uri` when `type` is omitted, matching the current optional API discriminator;
- still rejects every explicitly non-public destination type;
- canonicalizes only the exact whole-site form `<hostname>/*` to `<hostname>`;
- leaves path-scoped wildcards such as `<hostname>/api/*` untouched;
- keeps the rule that modern `destinations` supersede the legacy `domain` fallback.

The PLAN itself remains stricter than general Cloudflare wildcard matching: the AUD-selected parent application still has to resolve to the exact reviewed `control.rozkalns.net` whole-site destination. Broad wildcard subdomains and path-only applications do not satisfy this proof.

## Preserved boundaries

- parent selection still starts from the token AUD only as an untrusted lookup hint;
- the selected app is still re-bound cryptographically through exact issuer + RS256/JWKS verification;
- webhook Access application checks remain exact-path checks;
- the dedicated PLAN entrypoint remains incapable of APPLY/deploy;
- the existing APPLY gate is unchanged;
- no production PLAN retry is executed by this remediation PR.

## Source baseline note

An accidental temporary `placeholder` file was created directly on `main` while starting this remediation and was immediately removed. The restored `main=b6f45b0a098f18caafdb6626053880bdb426e1c7` has tree `cc575e661ceaa4ccf02f48042c02238e6bd31d6d`, exactly matching the pre-incident `fcc415fc4cbea175cecd184460d6a4f6b106e249` tree. Exact-main CI #290 / run `31897579730` completed successfully before this branch was created.

**Production deploy: NO.**
