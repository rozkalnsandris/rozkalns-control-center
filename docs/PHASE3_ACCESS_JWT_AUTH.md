# Phase 3 — Cloudflare Access JWT authentication boundary

Issue: #163

## Purpose

Phase 3 may eventually expose authenticated human decision actions such as Merge / Needs changes / Later. Before any such side effect exists, the Worker must independently prove the Cloudflare Access application JWT rather than trusting that a request merely passed through Access or contains an authentication-looking header.

This slice is deliberately source-only. It introduces the cryptographic verification boundary and deterministic tests, but does **not** wire it to a route, add GitHub write permission, change Cloudflare configuration, add a Worker binding, or deploy production code.

## External contract rechecked 2026-08-15

Current Cloudflare Access documentation describes the application token in the `Cf-Access-Jwt-Assertion` request header and requires origins/Workers that make authorization decisions to validate the JWT. Access application tokens are RS256 signed and are bound to the Access issuer/team domain plus the application audience. Cloudflare publishes rotating signing keys through the team-domain Access certs/JWKS endpoint.

The runtime implementation in this slice does not fetch that endpoint itself. Instead it receives an injected `CloudflareAccessSigningKeyResolver` which accepts only a validated bounded `kid` and returns the corresponding JWK. A later focused slice can own bounded JWKS transport/cache/rotation behavior without allowing request data to choose an arbitrary URL.

## Verification contract

`CloudflareAccessJwtVerifier`:

1. reads only `Cf-Access-Jwt-Assertion` for request authentication; no cookie fallback is accepted;
2. requires exactly three compact JWT segments within fixed size bounds;
3. parses only the JOSE header before cryptographic verification and requires `alg=RS256` plus a bounded non-empty `kid`;
4. resolves a signing JWK only by that validated `kid`;
5. accepts only RSA signing-key evidence compatible with RS256 verification;
6. verifies the signature over the exact encoded `header.payload` bytes;
7. only after signature success parses and validates claims;
8. requires application token `type=app`, exact configured issuer, exact configured audience membership, coherent integer `exp`/`iat`/`nbf`, and current validity;
9. requires a non-empty bounded `sub` so this human-auth boundary does not silently accept service-token-shaped principals with no human subject;
10. returns only `{ subject, email }`, with email optional, and never returns or logs the raw JWT, signature or key material.

Expected issuer configuration is restricted to an HTTPS `*.cloudflareaccess.com` origin with no credentials/path/query/fragment. The application audience is an opaque bounded identifier; the verifier does not assume a particular token/audience length beyond the safety bound.

## Fail-closed behavior

Stable failures cover missing/malformed token, invalid JOSE header, unavailable/invalid key, bad signature, malformed claims, wrong issuer/audience, expiry, future `nbf`, and future `iat`.

Tests use generated RSA keypairs and real RS256 signatures. They cover:

- successful exact verification;
- header-only request token source and cookie rejection;
- forged/wrong-key signature;
- signature verification before claim trust;
- unknown `kid` and invalid JWK;
- non-RS256 algorithm and malformed `kid`;
- wrong token type, issuer and audience;
- expiry / not-before / issued-at failures;
- malformed temporal/principal/email claims;
- unsafe verifier configuration;
- resolver input remaining only the validated opaque `kid` rather than any caller-controlled URL.

## Explicitly not activated

This change does not add:

- a mutation HTTP route;
- Merge / Needs changes / Later behavior;
- GitHub write permission or write transport;
- JWKS network fetch/caching;
- new Cloudflare Access application/policy state;
- Worker environment variables or secrets;
- D1 production write/migration;
- production deployment;
- RPi5/host/root mutation.

The next Phase 3 unit must continue from this boundary and remain separately reviewed. Any future live human side effect must still re-read authoritative GitHub state immediately before mutation, bind the approved expected SHA, preserve idempotency/audit evidence, and keep merge authorization separate from deployment authorization.

**Production deploy: NO.**
