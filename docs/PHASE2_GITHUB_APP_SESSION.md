# Phase 2 GitHub App installation session contract

Issue: #32  
PR: #33  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration, source-only credential/session boundary

## Purpose

Define the credential/session boundary that can later authenticate the reviewed bounded GitHub REST read transport without leaking private-key material, GitHub App JWTs or installation access tokens into domain models, Worker routes, fixtures, logs or documentation.

This is still a source-only contract. It does **not** create or install the real `Rozkalns Control` GitHub App, configure a Cloudflare secret, mint a live credential, call GitHub from the Worker or authorize production rollout.

## Official GitHub semantics used

The implementation follows the current GitHub App authentication contract rechecked on 2026-08-11:

- GitHub App JWT signing is `RS256` only;
- `iat` is backdated by 60 seconds for clock drift;
- `exp` is bounded below GitHub's 10-minute maximum future lifetime;
- the App client ID is used as the JWT issuer identity;
- GitHub App JWT REST authentication uses the Bearer scheme;
- installation access tokens are requested only from `POST /app/installations/{installation_id}/access_tokens`;
- requested repositories and permissions are explicitly narrowed in the token request;
- an installation token cannot grant more than the App/installation itself grants;
- installation credentials are short-lived and their string format is opaque.

The code intentionally contains no token-prefix or token-length rule.

## Identity and signing boundary

`GitHubAppIdentity` contains only the non-secret App client ID.

`GitHubAppJwtSigner` is the only signing abstraction:

```text
signing input bytes
  -> signRs256(...)
  -> signature bytes
```

The contract does not accept a PEM string, private-key bytes, a filesystem path, a Cloudflare binding name or another raw key representation.

A future runtime adapter may implement this signer using an approved secret source, but that adapter and the real secret are separate rollout work.

## JWT contract

For an authoritative observation time `T`:

```text
protected header:
  alg = RS256
  typ = JWT

claims:
  iat = floor(T / 1s) - 60s
  exp = floor(T / 1s) + 9m
  iss = configured GitHub App client ID
```

The module constructs the signing input deterministically and rejects malformed App identity, invalid time or empty/failed signatures with fixed sanitized errors.

JWT material is transient and is never returned as credential evidence.

## Installation-token exchange

The exchange boundary owns all HTTP metadata. A caller cannot choose another host, method, auth header or API version.

The request is fixed to:

```text
POST https://api.github.com/app/installations/{installation_id}/access_tokens
Accept: application/vnd.github+json
Authorization: Bearer <ephemeral app JWT>
X-GitHub-Api-Version: 2026-03-10
Content-Type: application/json
redirect: manual
```

The body is always derived from the already-validated `GitHubInstallationReadScope`:

```json
{
  "repositories": ["selected-repository-name"],
  "permissions": {
    "approved_phase2_permission": "read"
  }
}
```

This explicit narrowing is intentional. The source-only session boundary never asks GitHub to inherit a broader installation grant implicitly.

## Token-response verification

A successful token response must provide evidence for:

- opaque non-empty credential value;
- valid expiry timestamp;
- selected repository `full_name` values;
- effective permissions.

The module rebuilds a `GitHubInstallationReadScope` from the returned repository/permission evidence and requires exact equivalence with the requested scope.

Missing repositories, fewer repositories, extra repositories, missing permissions, write permissions, unapproved permissions or malformed evidence fail closed.

The resulting sanitized lease is validated through the existing Phase 2 contract:

- installation identity matches;
- repository set matches;
- permission set matches;
- short-lived lifetime remains within the existing maximum;
- at least the existing minimum safe lifetime remains at observation time.

Only this sanitized lease is returned to callers.

## Authorized read session

The raw installation credential remains inside the returned authorized-session closure.

The session accepts only the already-reviewed #31 GET envelope and revalidates:

- method is `GET`;
- media type is the integration-owned GitHub media type;
- REST version is `2026-03-10`;
- redirect policy is manual;
- URL origin is exactly `https://api.github.com`;
- URL remains inside one repository in the validated installation scope.

Only after those checks does the session add:

```text
Authorization: Bearer <opaque installation credential>
```

and perform the injected HTTP operation.

The #31 transport remains responsible for request validation, pagination, rate-limit evidence and response-shape handling. The #32 session is responsible only for credential acquisition and authenticated request execution.

## Fail-closed outcomes

The session exposes fixed typed failure classes for:

- invalid App identity or observation time;
- signing failure;
- token exchange transport failure;
- 401 / 403 / 404 / 422 token endpoint outcomes;
- unexpected token endpoint status;
- malformed token response;
- repository/permission scope mismatch;
- unusable token lease;
- invalid authorized GET envelope;
- authorized-read transport failure.

Remote response bodies, signer exception text, network exception text, JWTs and raw installation credentials are never copied into public error messages.

## Regression evidence

Deterministic tests use fake signer and fake HTTP dependencies only. They prove:

- JWT header/claim timing and issuer semantics;
- explicit repository + read-permission narrowing;
- token format/length opacity;
- exact repository/permission response matching;
- lease expiry/lifetime validation;
- sanitized endpoint/signing/transport errors;
- compatibility with the merged #31 bounded REST transport;
- off-origin/out-of-scope reads fail before authenticated HTTP;
- source boundaries keep JWT/token/Authorization primitives out of shared/domain/Worker code;
- no Wrangler secret/var binding is introduced.

Source/test CI #88 (`31532945111`) passed policy checks, runtime audit, typecheck, typed lint, all unit tests, build and Wrangler dry-run before this documentation reconciliation.

## Runtime and rollout boundary

There is still no live signer, private key, Cloudflare secret, real GitHub App installation, live token exchange or Worker read route.

A future rollout step must separately reconcile:

1. the dedicated `Rozkalns Control` GitHub App identity;
2. exact selected repositories and minimum read permissions;
3. approved secret storage for the private key;
4. real signer implementation;
5. a narrowly scoped live canary;
6. the then-current RPi5 sequencing contract.

As of this issue, `RPi5_main#163` remains the current Phase 3 baseline-reconciliation gate before its future AUTO canary. Control live rollout remains separately blocked from production activation.

## Deploy impact

`DEPLOY_REQUIRED=no`.

This source/tests/docs work does not add a runtime binding, Worker route, production credential or deployment path.