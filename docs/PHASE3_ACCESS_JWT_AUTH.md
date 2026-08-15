# Phase 3 — Cloudflare Access JWT authentication boundary

Issues: #163, #165

## Purpose

Phase 3 may eventually expose authenticated human decision actions such as Merge / Needs changes / Later. Before any such side effect exists, the Worker must independently prove the Cloudflare Access application JWT rather than trusting that a request merely passed through Access or contains an authentication-looking header.

The Phase 3 authentication foundation is deliberately split into reviewed source-only slices. #163/#164 introduced the cryptographic JWT verifier. #165 adds the bounded Access signing-key transport/cache/rotation resolver. Neither slice wires authentication to a mutation route, adds GitHub write permission, changes Cloudflare configuration, adds a Worker binding, or deploys production code.

## External contract rechecked 2026-08-15

Current Cloudflare Access documentation describes the application token in the `Cf-Access-Jwt-Assertion` request header and requires origins/Workers that make authorization decisions to validate the JWT. Access application tokens are RS256 signed and are bound to the Access issuer/team domain plus the application audience.

Cloudflare publishes account signing keys at:

`https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`

The certs response exposes the current and previous signing keys in JWK form. Cloudflare documents default signing-key rotation at roughly six weeks and keeps the previous key valid for seven days after rotation. The application therefore must not pin one public key indefinitely; it must match the JWT `kid` against the bounded key set from the fixed team-domain endpoint.

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

## JWKS resolver contract

`CloudflareAccessJwksResolver`:

1. accepts only the validated team issuer as configuration and deterministically derives exactly one `/cdn-cgi/access/certs` URL;
2. never lets a JWT header, `kid`, request URL or other caller-controlled value select a network origin/path;
3. performs only a `GET` for the fixed certs endpoint, with redirects rejected and a bounded request timeout;
4. bounds declared and streamed response size before JSON admission;
5. accepts only a small non-empty `keys` array with unique bounded `kid` values and RSA / RS256 / signing-use evidence;
6. strips unrelated JWK response fields before caching and returns cloned key material to callers;
7. keeps current+previous keys in an in-memory cache for a short bounded TTL;
8. serves a known `kid` directly from a fresh cache without network I/O;
9. on a fresh-cache `kid` miss, performs at most one immediate refresh so a newly rotated signing key can be discovered without waiting for TTL expiry;
10. coalesces concurrent refreshes into one fetch so request bursts do not fan out duplicate certs requests;
11. replaces the cache only after an entire newly fetched key set passes validation, so malformed refreshes cannot poison a prior good cache;
12. fails closed for network/timeout, redirect/non-2xx, oversized/malformed response, unsafe/duplicate keys and still-unknown `kid`.

The cache is isolate-memory optimization only. It is not durable state, does not contain Access JWTs or private key material, and correctness never depends on cache persistence across Worker isolates.

## Fail-closed behavior

Stable verifier failures cover missing/malformed token, invalid JOSE header, unavailable/invalid key, bad signature, malformed claims, wrong issuer/audience, expiry, future `nbf`, and future `iat`.

Stable resolver failures cover invalid fixed configuration, fetch/timeout failure, invalid HTTP/body evidence, malformed/unsafe JWKS sets and unknown `kid` after the single bounded refresh.

Tests use generated RSA signatures for the verifier and deterministic synthetic JWKS responses for the resolver. Together they cover:

- successful exact JWT verification;
- header-only request token source and cookie rejection;
- forged/wrong-key signature;
- signature verification before claim trust;
- unknown `kid` and invalid JWK;
- non-RS256 algorithm and malformed `kid`;
- wrong token type, issuer and audience;
- expiry / not-before / issued-at failures;
- malformed temporal/principal/email claims;
- unsafe verifier configuration;
- fixed JWKS endpoint derivation;
- current+previous rotation key lookup;
- cache hit and TTL refresh;
- immediate refresh-on-`kid`-miss;
- concurrent refresh coalescing;
- network/non-2xx/oversize/malformed/duplicate/unsafe JWKS failure;
- preservation of a prior good cache when a refresh fails;
- request/JWT data never controlling the JWKS URL.

## Explicitly not activated

These source-only slices do not add:

- a mutation HTTP route;
- Merge / Needs changes / Later behavior;
- GitHub write permission or write transport;
- live route wiring to the JWKS resolver/verifier;
- new Worker environment variables or secrets;
- a production JWKS fetch/canary;
- new Cloudflare Access application/policy state;
- D1 production write/migration;
- production deployment;
- RPi5/host/root mutation.

The next Phase 3 unit must continue from this boundary and remain separately reviewed. Any future live human side effect must still re-read authoritative GitHub state immediately before mutation, bind the approved expected SHA, preserve idempotency/audit evidence, and keep merge authorization separate from deployment authorization.

**Production deploy: NO.**
